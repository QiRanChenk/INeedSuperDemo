import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chat } from './llm.js';
import { getSettings, SDK_DIR } from './config.js';
import { readProject, projectDir, safePath, fileTree } from './registry.js';
import { restart, logs } from './runner.js';
import { loadHistory, saveHistory, resolveSession } from './sessions.js';
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
const emptyUsage = () => ({ input: 0, output: 0, cached: 0, total: 0, calls: 0 });

/** Normalize OpenAI / DeepSeek / Qwen / GLM usage shapes into { input, output, cached, total }. */
export function normalizeUsage(u) {
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  return { input, output, cached, total: u.total_tokens ?? input + output };
}
function addUsage(acc, u) { acc.input += u.input; acc.output += u.output; acc.cached += u.cached; acc.total += u.total; acc.calls += 1; return acc; }

export function loadProjectUsage(id) {
  try { return { ...emptyUsage(), ...JSON.parse(fs.readFileSync(usageFile(id), 'utf8')) }; } catch { return emptyUsage(); }
}
function recordProjectUsage(id, u) {
  const acc = addUsage(loadProjectUsage(id), u);
  fs.mkdirSync(path.dirname(usageFile(id)), { recursive: true });
  fs.writeFileSync(usageFile(id), JSON.stringify(acc));
  return acc;
}
/** Session usage = sum over one session's history. */
export function sessionUsage(id, sid) {
  const acc = emptyUsage();
  for (const m of loadHistory(id, sid)) if (m.usage) addUsage(acc, m.usage);
  return acc;
}
export function usageSummary(id, sid) { return { session: sessionUsage(id, sid), project: loadProjectUsage(id) }; }

// ---- context compaction ----
// Full detail is kept for the current and previous turn; older tool results / file contents are collapsed to one line.
// A turn = one user message and everything the agent did in response.
const KEEP_FULL_TURNS = 2;
const SOFT_LIMIT_CHARS = 240_000; // ~80k tokens; beyond this even the previous turn is compacted

export function compactHistory(history) {
  let turn = 0;
  const turnOf = history.map(m => (m.role === 'user' && !m.system) ? ++turn : turn);
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

const running = new Set();
export function isBusy(id) { return running.has(id); }

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
      return runCommand(projectDir(id), args.command);
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

function runCommand(cwd, command) {
  return new Promise(resolve => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: 60_000, maxBuffer: 2_000_000, env: { ...process.env, CI: '1' } },
      (err, stdout, stderr) => {
        let out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
        if (err) out += `\n[exit] ${err.code ?? err.signal ?? err.message}`;
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
  running.add(id);
  try { return await runAgentInner(project, userMessage, onEvent, resolveSession(id, sessionId)); }
  finally { running.delete(id); }
}

async function runAgentInner(project, userMessage, onEvent, sid) {
  const id = project.id;
  const settings = getSettings();
  const history = loadHistory(id, sid);
  const ctx = { changed: new Set() };
  // persist after every message so the UI can replay an in-progress turn when switching projects/sessions
  const push = m => { history.push(m); saveHistory(id, sid, history); };

  push({ role: 'user', content: userMessage, ts: Date.now() });
  const system = { role: 'system', content: systemPrompt(project) };
  let messages = [];
  const rebuild = () => {
    const c = compactHistory(history);
    messages = [system, ...c.messages];
    onEvent({ type: 'context', session: sid, messages: messages.length, compacted: c.compacted, chars: c.chars + system.content.length });
  };
  rebuild();

  let finalText = '';
  for (let i = 0; i < settings.maxIterations; i++) {
    onEvent({ type: 'thinking', iteration: i + 1 });
    const { message, usage } = await chat({ messages, tools: TOOLS, settings });
    const nu = normalizeUsage(usage);

    const assistant = { role: 'assistant', content: message.content ?? '', ts: Date.now() };
    if (nu) { assistant.usage = nu; recordProjectUsage(id, nu); }
    if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls;
    if (message.reasoning_content) assistant.reasoning = message.reasoning_content; // deepseek-reasoner / GLM thinking
    messages.push(strip(assistant));
    push(assistant);

    if (nu) onEvent({ type: 'usage', ...usageSummary(id) });
    if (assistant.reasoning) onEvent({ type: 'reasoning', content: assistant.reasoning });
    if (!message.tool_calls?.length) { finalText = message.content || ''; break; }
    if (message.content) onEvent({ type: 'text', content: message.content });

    for (const tc of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
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
    rebuild();
  }

  if (!finalText) { finalText = '（已达到最大迭代次数，停止。你可以继续对话让我接着做。）'; push({ role: 'assistant', content: finalText, ts: Date.now() }); }
  onEvent({ type: 'done', session: sid, content: finalText });
  return finalText;
}

function strip(m) {
  const { ts, system, reasoning, name, usage, ...rest } = m; // reasoning must NOT be sent back (DeepSeek rejects it)
  if (rest.role === 'assistant' && rest.content == null) rest.content = '';
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
    const ask = async msgs => cleanName((await chat({ temperature: 0.2, messages: msgs })).message.content);
    let name = await ask([{ role: 'system', content: system }, { role: 'user', content: String(description).slice(0, 2000) }]);
    if ([...name].length > MAX_NAME) {
      name = await ask([{ role: 'system', content: system }, { role: 'user', content: `把「${name}」压缩到不超过 ${MAX_NAME} 个字，保留核心业务含义，只输出名字。` }]);
    }
    return smartCut(name) || fallbackName(description);
  } catch { return fallbackName(description); }
}
