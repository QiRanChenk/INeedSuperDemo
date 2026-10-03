import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chat, StoppedError } from './llm.js';
import { getSettings, SDK_DIR } from './config.js';
import { readProject, projectDir, safePath, fileTree } from './registry.js';
import { restart, logs } from './runner.js';
import { loadHistory, saveHistory, resolveSession } from './sessions.js';
import { logUsage } from './usagelog.js';
export { loadHistory, clearHistory } from './sessions.js';

const TOOLS = [
  tool('list_files', '列出项目目录树（相对项目根目录）', { path: { type: 'string', description: '相对路径，默认 "."' } }),
  tool('read_file', '读取项目内一个文件的内容', { path: { type: 'string' } }, ['path']),
  tool('write_file', '写入（覆盖或新建）项目内文件，自动创建目录', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('delete_file', '删除项目内文件', { path: { type: 'string' } }, ['path']),
  tool('run_command', '在项目根目录执行 shell 命令（如 npm install xxx），60 秒超时', { command: { type: 'string' } }, ['command']),
  tool('get_logs', '获取项目进程最近的运行日志（stdout/stderr），用于排错', { lines: { type: 'integer', description: '默认 60' } }),
  tool('restart_project', '立即重启项目进程并返回启动状态。写文件后会自动重启，通常不需要手动调用', {}),
];

function tool(name, description, props, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } };
}

// ---- token usage ----
function usageFile(id) { return path.join(projectDir(id), '.superdemo', 'usage.json'); }
// ms / timedOutput: wall-clock time and output tokens of calls that carried timing -> average output speed (t/s). lastSpeed: most recent call.
const emptyUsage = () => ({ input: 0, output: 0, cached: 0, total: 0, calls: 0, ms: 0, timedOutput: 0, lastSpeed: null });

/** Normalize OpenAI / DeepSeek / Qwen / GLM usage shapes into { input, output, cached, total }. */
export function normalizeUsage(u, ms, ttft) {
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  const n = { input, output, cached, total: u.total_tokens ?? input + output };
  if (ms > 0) n.ms = ms;
  if (ttft > 0 && ms > ttft) n.gen = ms - ttft; // streaming: generation time after first token
  return n;
}
/** Output tokens per second for one call. Streaming: over generation time (after first token); non-streaming: whole request. */
const genMs = u => (u.gen > 0 ? u.gen : u.ms);
export const speedOf = u => u && genMs(u) > 0 && u.output > 0 ? Math.round(u.output / (genMs(u) / 1000)) : null;
function addUsage(acc, u) {
  acc.input += u.input; acc.output += u.output; acc.cached += u.cached; acc.total += u.total; acc.calls += 1;
  if (u.ms > 0) { acc.ms = (acc.ms || 0) + genMs(u); acc.timedOutput = (acc.timedOutput || 0) + u.output; acc.lastSpeed = speedOf(u); }
  return acc;
}
const withSpeed = acc => ({ ...acc, avgSpeed: acc.ms > 0 ? Math.round(acc.timedOutput / (acc.ms / 1000)) : null });

export function loadProjectUsage(id) {
  try { return { ...emptyUsage(), ...JSON.parse(fs.readFileSync(usageFile(id), 'utf8')) }; } catch { return emptyUsage(); }
}
function recordProjectUsage(id, u, sid = '') {
  logUsage({ p: id, s: sid, i: u.input, o: u.output, c: u.cached });
  const acc = addUsage(loadProjectUsage(id), u);
  fs.mkdirSync(path.dirname(usageFile(id)), { recursive: true });
  fs.writeFileSync(usageFile(id), JSON.stringify(acc));
  return acc;
}
/** Session usage = sum over one session's history. */
export function sessionUsage(id, sid) {
  const acc = emptyUsage();
  // older messages lack usage.ms: approximate the call duration from the gap to the preceding message (pushed right before the LLM call)
  let prev = null;
  for (const m of loadHistory(id, sid)) {
    if (m.usage) addUsage(acc, m.usage.ms > 0 || !(prev?.ts && m.ts > prev.ts) ? m.usage : { ...m.usage, ms: m.ts - prev.ts });
    prev = m;
  }
  return withSpeed(acc);
}
export function usageSummary(id, sid) { return { session: sessionUsage(id, sid), project: withSpeed(loadProjectUsage(id)) }; }

// ---- context compaction ----
// Full detail is kept for the current and previous turn; older tool results / file contents are collapsed to one line.
// A turn = one user message and everything the agent did in response.
const KEEP_FULL_TURNS = 2;
const SOFT_LIMIT_CHARS = 240_000; // ~80k tokens; beyond this even the previous turn is compacted

/** Rough token estimate: CJK ~0.75 token/char, everything else ~3.5 chars/token. */
export function estimateTokens(text) {
  const str = String(text ?? '');
  let cjk = 0;
  for (const ch of str) { const c = ch.codePointAt(0); if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++; }
  return Math.round(cjk * 0.75 + (str.length - cjk) / 3.5);
}

/** What the next request would contain for this session: message count, compaction count, chars, estimated tokens. */
export function getContextInfo(id, sid) {
  const project = readProject(id);
  if (!project) throw new Error('project not found');
  const history = loadHistory(id, sid);
  const c = compactHistory(history);
  const sys = systemPrompt(project);
  const all = sys + JSON.stringify(c.messages);
  return { session: resolveSession(id, sid), messages: c.messages.length + 1, compacted: c.compacted, chars: all.length, tokens: estimateTokens(all), window: getSettings().contextWindow };
}

export function compactHistory(history) {
  let turn = 0;
  const turnOf = history.map(m => (m.role === 'user' && !m.system && !m.interjection) ? ++turn : turn);
  const build = keep => history.map((m, i) => strip(turn - turnOf[i] < keep ? m : compactMessage(m)));
  let out = build(KEEP_FULL_TURNS);
  if (JSON.stringify(out).length > SOFT_LIMIT_CHARS) out = build(1);
  const compacted = out.filter(m => m._compacted).length;
  for (const m of out) delete m._compacted;
  return { messages: out, compacted, chars: JSON.stringify(out).length };
}

function compactMessage(m) {
  if (m.role === 'tool') {
    const c = String(m.content ?? '');
    if (c.length <= 160) return m;
    return { ...m, _compacted: true, content: `[旧结果已省略，原 ${c.length} 字符] ${c.split('\n')[0].slice(0, 120)}` };
  }
  if (m.role === 'assistant' && m.tool_calls) {
    let changed = false;
    const tool_calls = m.tool_calls.map(tc => {
      let args; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { return tc; }
      if (typeof args.content === 'string' && args.content.length > 200) { args.content = `<已省略 ${args.content.length} 字符>`; changed = true; }
      return { ...tc, function: { ...tc.function, arguments: JSON.stringify(args) } };
    });
    return changed ? { ...m, _compacted: true, tool_calls } : m;
  }
  if (m.role === 'user' && m.system) return { ...m, _compacted: true, content: String(m.content).split('\n')[0] };
  return m;
}

// In-flight runs: projectId -> { sid, subs, live }. Every UI event fans out to all subscribers (initiating tab + any tab that
// attached later). `live` holds only the not-yet-persisted state (current iteration + streamed delta) so a late attacher can
// catch up after rendering the persisted history.
const running = new Map();
export function isBusy(id) { return running.has(id); }
function makeRun(sid, onEvent) {
  const run = { sid, subs: new Set(onEvent ? [onEvent] : []), live: { iteration: 0, content: '', reasoning: '' }, ended: false, ctrl: new AbortController(), queue: [] };
  run.emit = ev => {
    const l = run.live;
    if (ev.type === 'thinking') { l.iteration = ev.iteration; l.content = ''; l.reasoning = ''; }
    else if (ev.type === 'delta') { if (ev.content) l.content += ev.content; if (ev.reasoning) l.reasoning += ev.reasoning; }
    else if (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'done') { l.content = ''; l.reasoning = ''; }
    for (const fn of run.subs) { try { fn(ev); } catch {} }
  };
  return run;
}
/** Ask the in-flight run of a project to stop (aborts the LLM call / running command; the loop exits at the next checkpoint). */
export function stopRun(id) {
  const run = running.get(id);
  if (!run || run.ended) return false;
  run.ctrl.abort();
  run.emit({ type: 'stopping' });
  return true;
}
// Messages typed while a run is in progress and deliberately held back: projectId -> [{ id, text, sid, ts }].
// When the run ends they are merged (same session) into one user message and sent as the next turn automatically.
const pending = new Map();
export function listQueue(id) { return pending.get(id) || []; }
const broadcastQueue = id => { const run = running.get(id); if (run && !run.ended) run.emit({ type: 'queue', items: listQueue(id) }); };
/** Add to the queue. Returns null when the project is idle (caller should send the message normally). */
export function enqueue(id, text, sessionId) {
  if (!running.has(id)) return null;
  const sid = resolveSession(id, sessionId);
  const items = listQueue(id);
  items.push({ id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, sid, ts: Date.now() });
  pending.set(id, items);
  broadcastQueue(id);
  return items;
}
export function dequeue(id, qid) {
  const items = listQueue(id).filter(q => q.id !== qid);
  items.length ? pending.set(id, items) : pending.delete(id);
  broadcastQueue(id);
  return items;
}
export function clearQueue(id) { pending.delete(id); broadcastQueue(id); return []; }
/** Run finished: fire the queued messages of one session as a single new turn (other sessions wait for the next round). */
function startQueued(id) {
  const items = listQueue(id);
  if (!items.length) return false;
  const sid = items[0].sid;
  const batch = items.filter(q => q.sid === sid), rest = items.filter(q => q.sid !== sid);
  rest.length ? pending.set(id, rest) : pending.delete(id);
  runAgent(id, batch.map(q => q.text).join('\n\n'), null, sid).catch(e => console.error(`[queue] ${id}:`, e.message));
  return true;
}
/** Queue a mid-run user message; it is appended to the conversation at the next checkpoint (after the current LLM call / tool batch). */
export function interject(id, text) {
  const run = running.get(id);
  if (!run || run.ended) return false;
  run.queue.push(text);
  run.emit({ type: 'interjected', content: text });
  return true;
}
/** Subscribe to an in-flight run: replays the live (unpersisted) state, then streams events until done. Returns unsubscribe, or null if idle. */
export function attachRun(id, onEvent) {
  const run = running.get(id);
  if (!run || run.ended) return null;
  onEvent({ type: 'attached', session: run.sid, iteration: run.live.iteration, queue: listQueue(id) });
  if (run.live.iteration) onEvent({ type: 'thinking', iteration: run.live.iteration });
  if (run.live.content || run.live.reasoning) onEvent({ type: 'delta', content: run.live.content || undefined, reasoning: run.live.reasoning || undefined });
  run.subs.add(onEvent);
  return () => run.subs.delete(onEvent);
}

function systemPrompt(project) {
  let sdkDoc = '';
  try { sdkDoc = fs.readFileSync(path.join(SDK_DIR, 'README.md'), 'utf8'); } catch {}
  const tree = fileTree(project.id).join('\n');
  return `你是 SuperDemo 壳内的项目构建 agent，负责按用户需求持续改造一个正在运行的项目。

# 当前项目
- 名称: ${project.name}
- 类型: ${project.type}（${project.type === 'web' ? 'B/S Web 应用，有前端页面' : '无界面服务'}）
- 描述: ${project.description || '（无）'}
- 入口: ${project.entry}，监听 process.env.PORT
- 目录树:
${tree}

# 硬性规则
1. 项目通过 sdk/ 目录获得 HTTP 路由、LLM 调用、数据源、洞察分析能力。优先使用 sdk，不要重复实现；除非用户明确要求，不要修改 sdk/ 下文件。
2. 前端页面中所有 URL（fetch、link、script、img）必须用相对路径，如 "api/xxx" 或 "./app.js"，禁止以 "/" 开头。项目通过反向代理在 /p/<id>/ 子路径下访问。
3. 仅使用 Node 内置模块（node:http、node:fs 等）。确实需要第三方包时，先 run_command "npm install <pkg>"，再在代码中 import。
4. 你写文件后壳会自动重启项目并把启动日志反馈给你；不要自己启动服务器进程。如启动失败，读日志、修复、再试。
5. 修改前先 read_file 了解现状；整文件覆盖时确保内容完整。改动小而完整，保持已有功能可用。
6. 项目要能独立部署：不要依赖壳的任何文件，只依赖项目目录内内容和环境变量。
9. 面向用户的界面绝不暴露技术栈与技术细节：页面文字、提示、页脚、空状态、状态栏中禁止出现 SQLite、数据库、数据表、表名、Node、SDK、API、JSON、接口、端口、文件路径、模型名等词汇；一律用业务语言（如"已保存"而非"已写入数据库"，"历史记录"而非"analyses 表"）。用户是业务人员，不是开发者。技术说明只写在 README 或代码注释里。
8. 数据存储必须是真数据库：任何需要保存的数据（表单、用户、订单、配置、上传数据集等）都必须通过 sdk 的 openDb()（SQLite，文件 data/app.db）建表存取，禁止用内存变量、全局数组或 JSON 文件充当数据库。用 db.ensureTable 在启动时建表，读写用 db.query / db.insert / db.run。
7. 全部完成后，用简短中文向用户说明：改了哪些文件、新增了什么能力、如何验证。不要输出整段代码。

# SDK 文档
${sdkDoc}`;
}

async function execTool(project, name, args, ctx) {
  const id = project.id;
  switch (name) {
    case 'list_files':
      return fileTree(id, args.path || '.').join('\n') || '(empty)';
    case 'read_file': {
      const abs = safePath(id, args.path);
      if (!fs.existsSync(abs)) return `ERROR: 文件不存在 ${args.path}`;
      const txt = fs.readFileSync(abs, 'utf8');
      return txt.length > 60_000 ? txt.slice(0, 60_000) + '\n...(truncated)' : txt;
    }
    case 'write_file': {
      const abs = safePath(id, args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content ?? '');
      ctx.changed.add(args.path);
      return `OK: wrote ${args.path} (${Buffer.byteLength(args.content ?? '')} bytes)`;
    }
    case 'delete_file': {
      const abs = safePath(id, args.path);
      if (fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true }); ctx.changed.add(args.path); return 'OK: deleted'; }
      return 'ERROR: 不存在';
    }
    case 'run_command':
      ctx.changed.add('(command)');
      return runCommand(projectDir(id), args.command, ctx.signal);
    case 'get_logs':
      return formatLogs(id, args.lines || 60);
    case 'restart_project': {
      const st = await restart(id);
      ctx.changed.clear();
      return `status=${st.status}\n${formatLogs(id, 30)}`;
    }
    default:
      return `ERROR: unknown tool ${name}`;
  }
}

function formatLogs(id, n) {
  const ls = logs(id).slice(-n);
  return ls.length ? ls.map(l => `[${l.stream}] ${l.line}`).join('\n') : '(no logs)';
}

function runCommand(cwd, command, signal) {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: 60_000, maxBuffer: 2_000_000, env: { ...process.env, CI: '1' }, signal },
      (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
        if (err) out += err.name === 'AbortError' ? '\n[exit] 已被用户停止' : `\n[exit] ${err.code ?? err.signal ?? err.message}`;
        resolve(out.trim().slice(-8000) || '(no output)');
      });
  });
}

/**
 * Run one agent turn: user message -> tool loop -> final assistant text.
 * onEvent receives { type, ... } events for the UI stream.
 */
export async function runAgent(id, userMessage, onEvent, sessionId) {
  const project = readProject(id);
  if (!project) throw new Error('project not found');
  if (running.has(id)) throw new Error('该项目正在处理上一条消息');
  const sid = resolveSession(id, sessionId);
  const run = makeRun(sid, onEvent);
  running.set(id, run);
  try { return await runAgentInner(project, userMessage, run, sid); }
  catch (e) { run.emit({ type: 'error', message: e.message }); e.emitted = true; throw e; }
  finally { run.ended = true; running.delete(id); if (startQueued(id)) run.emit({ type: 'next' }); run.subs.clear(); } // 'next': queued messages started a follow-up turn, clients re-attach
}

const STOP_NOTE = '（用户已停止本轮处理）';

async function runAgentInner(project, userMessage, run, sid) {
  const id = project.id;
  const onEvent = run.emit, signal = run.ctrl.signal;
  const settings = getSettings();
  const history = loadHistory(id, sid);
  const ctx = { changed: new Set(), signal };
  // persist after every message so the UI can replay an in-progress turn when switching projects/sessions
  const push = m => { history.push(m); saveHistory(id, sid, history); };
  // Mid-run user messages (interjections) become extra user turns at checkpoints so the model sees them before continuing.
  const drain = () => {
    if (!run.queue.length) return false;
    for (const t of run.queue.splice(0)) push({ role: 'user', content: t, ts: Date.now(), interjection: true });
    return true;
  };
  // User pressed stop: close the turn with an assistant note (keeps the history valid for the next request) and finish.
  const stopped = () => {
    const last = history[history.length - 1];
    if (last?.role !== 'assistant' || last.tool_calls) push({ role: 'assistant', content: STOP_NOTE, ts: Date.now(), stopped: true });
    onEvent({ type: 'done', session: sid, content: '', stopped: true });
    return '';
  };

  push({ role: 'user', content: userMessage, ts: Date.now() });
  const system = { role: 'system', content: systemPrompt(project) };
  let messages = [];
  const rebuild = () => {
    const c = compactHistory(history);
    messages = [system, ...c.messages];
    const all = system.content + JSON.stringify(c.messages);
    onEvent({ type: 'context', session: sid, messages: messages.length, compacted: c.compacted, chars: all.length, tokens: estimateTokens(all), window: settings.contextWindow });
  };
  rebuild();

  let finalText = '';
  for (let i = 0; i < settings.maxIterations; i++) {
    onEvent({ type: 'thinking', iteration: i + 1 });
    let r;
    try { r = await chat({ messages, tools: TOOLS, settings, signal, onDelta: d => onEvent({ type: 'delta', ...d }) }); }
    catch (e) { if (e instanceof StoppedError || signal.aborted) return stopped(); throw e; }
    const { message, usage, ms, ttft, aborted } = r;
    const nu = normalizeUsage(usage, ms, ttft);

    const assistant = { role: 'assistant', content: message.content ?? '', ts: Date.now() };
    if (aborted) { if (!assistant.content && !message.reasoning_content) return stopped(); assistant.content += (assistant.content ? '\n\n' : '') + STOP_NOTE; assistant.stopped = true; }
    if (nu) { assistant.usage = nu; recordProjectUsage(id, nu, sid); }
    if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls;
    if (message.reasoning_content) assistant.reasoning = message.reasoning_content; // deepseek-reasoner / GLM thinking
    messages.push(strip(assistant));
    push(assistant);

    if (nu) onEvent({ type: 'usage', ...usageSummary(id) });
    if (assistant.reasoning) onEvent({ type: 'reasoning', content: assistant.reasoning });
    if (aborted) { onEvent({ type: 'text', content: assistant.content }); return stopped(); }
    if (!message.tool_calls?.length) {
      // model considers itself done, but the user added something meanwhile: show the answer and go another round
      if (drain()) { if (message.content) onEvent({ type: 'text', content: message.content }); rebuild(); continue; }
      finalText = message.content || ''; break;
    }
    if (message.content) onEvent({ type: 'text', content: message.content });

    for (const tc of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      // stopped mid-batch: every tool_call still needs a tool message, otherwise the next request is rejected
      if (signal.aborted) { push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: '[已被用户停止，未执行]', ts: Date.now() }); continue; }
      onEvent({ type: 'tool_call', name: tc.function.name, args: summarizeArgs(args) });
      let result;
      try { result = await execTool(project, tc.function.name, args, ctx); }
      catch (e) { result = 'ERROR: ' + e.message; }
      onEvent({ type: 'tool_result', name: tc.function.name, preview: String(result).slice(0, 300) });
      push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: String(result), ts: Date.now() });
    }

    // Auto restart after a batch of file changes so the model sees the effect.
    if (ctx.changed.size) {
      onEvent({ type: 'restarting', files: [...ctx.changed] });
      const st = await restart(id);
      ctx.changed.clear();
      onEvent({ type: 'restarted', status: st.status });
      const note = { role: 'user', content: `[系统] 项目已自动重启，状态=${st.status}。最近日志:\n${formatLogs(id, 25)}\n${st.status === 'running' ? '若已完成，请向用户总结；否则继续修复。' : '启动失败，请读取日志修复。'}`, ts: Date.now(), system: true };
      push(note);
    }
    if (signal.aborted) return stopped();
    drain();
    rebuild();
  }

  if (!finalText) { finalText = '（已达到最大迭代次数，停止。你可以继续对话让我接着做。）'; push({ role: 'assistant', content: finalText, ts: Date.now() }); }
  onEvent({ type: 'done', session: sid, content: finalText });
  return finalText;
}

function strip(m) {
  const { ts, system, reasoning, name, usage, stopped, interjection, ...rest } = m; // reasoning must NOT be sent back (DeepSeek rejects it)
  if (rest.role === 'assistant' && rest.content == null) rest.content = '';
  if (interjection) rest.content = `[用户插话，请在继续当前任务时一并考虑] ${rest.content}`;
  return rest;
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + `…(${v.length} chars)` : v;
  return out;
}

/** Generate a project name (<= 10 chars) from the description; falls back to the description head. */
const MAX_NAME = 10;
const cleanName = raw => String(raw || '').split('\n').map(l => l.trim()).filter(Boolean)[0]?.replace(/^[「『"'“‘《\[（(]+|[」』"'”’》\]）)。.!！]+$/g, '').trim() || '';
/** Cut at the first punctuation / space; hard-cut at MAX_NAME only as a last resort. */
function smartCut(name) {
  const seg = String(name).split(/[\s，,、。;；:：（）()|/\-—]+/).filter(Boolean)[0] || '';
  const chars = [...seg];
  return chars.length <= MAX_NAME ? seg : chars.slice(0, MAX_NAME).join('');
}
function fallbackName(description) {
  const d = String(description).replace(/\s+/g, ' ').trim().replace(/^(请|帮我|我想|我要|我们|需要|希望|想|要)*(做|开发|实现|设计|搭建|写|建|弄)?(一个|个|一套|套|一款|款)?/, '');
  return smartCut(d) || '新项目';
}
export async function generateProjectName(description) {
  const system = `你给软件项目起名。根据需求描述输出一个简短、具体、面向业务的中文项目名：严格不超过 ${MAX_NAME} 个汉字，不含标点、引号、空格，不带"项目/系统/平台/Demo/小助手/管理"等冗余后缀。只输出名字本身。`;
  try {
    const ask = async msgs => { const r = await chat({ temperature: 0.2, messages: msgs }); const u = normalizeUsage(r.usage); if (u) logUsage({ p: '_naming', i: u.input, o: u.output, c: u.cached }); return cleanName(r.message.content); };
    let name = await ask([{ role: 'system', content: system }, { role: 'user', content: String(description).slice(0, 2000) }]);
    if ([...name].length > MAX_NAME) {
      name = await ask([{ role: 'system', content: system }, { role: 'user', content: `把「${name}」压缩到不超过 ${MAX_NAME} 个字，保留核心业务含义，只输出名字。` }]);
    }
    return smartCut(name) || fallbackName(description);
  } catch { return fallbackName(description); }
}
