import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chat } from './llm.js';
import { getSettings, SDK_DIR } from './config.js';
import { readProject, projectDir, safePath, fileTree } from './registry.js';
import { restart, logs } from './runner.js';

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

function historyFile(id) { return path.join(projectDir(id), '.superdemo', 'history.json'); }

export function loadHistory(id) {
  try { return JSON.parse(fs.readFileSync(historyFile(id), 'utf8')); } catch { return []; }
}

function saveHistory(id, history) {
  fs.mkdirSync(path.dirname(historyFile(id)), { recursive: true });
  fs.writeFileSync(historyFile(id), JSON.stringify(history, null, 2));
}

export function clearHistory(id) { saveHistory(id, []); }

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
/** Session usage = sum over the current (un-cleared) history. */
export function sessionUsage(id) {
  const acc = emptyUsage();
  for (const m of loadHistory(id)) if (m.usage) addUsage(acc, m.usage);
  return acc;
}
export function usageSummary(id) { return { session: sessionUsage(id), project: loadProjectUsage(id) }; }

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
export async function runAgent(id, userMessage, onEvent) {
  const project = readProject(id);
  if (!project) throw new Error('project not found');
  if (running.has(id)) throw new Error('该项目正在处理上一条消息');
  running.add(id);
  try { return await runAgentInner(project, userMessage, onEvent); }
  finally { running.delete(id); }
}

async function runAgentInner(project, userMessage, onEvent) {
  const id = project.id;
  const settings = getSettings();
  const history = loadHistory(id);
  const ctx = { changed: new Set() };
  // persist after every message so the UI can replay an in-progress turn when switching projects
  const push = m => { history.push(m); saveHistory(id, history); };

  push({ role: 'user', content: userMessage, ts: Date.now() });
  const messages = [{ role: 'system', content: systemPrompt(project) }, ...history.map(strip)];

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
      const toolMsg = { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: String(result), ts: Date.now() };
      messages.push(strip(toolMsg));
      push(toolMsg);
    }

    // Auto restart after a batch of file changes so the model sees the effect.
    if (ctx.changed.size) {
      onEvent({ type: 'restarting', files: [...ctx.changed] });
      const st = await restart(id);
      ctx.changed.clear();
      onEvent({ type: 'restarted', status: st.status });
      const note = { role: 'user', content: `[系统] 项目已自动重启，状态=${st.status}。最近日志:\n${formatLogs(id, 25)}\n${st.status === 'running' ? '若已完成，请向用户总结；否则继续修复。' : '启动失败，请读取日志修复。'}`, ts: Date.now(), system: true };
      messages.push(strip(note));
      push(note);
    }
  }

  if (!finalText) { finalText = '（已达到最大迭代次数，停止。你可以继续对话让我接着做。）'; push({ role: 'assistant', content: finalText, ts: Date.now() }); }
  onEvent({ type: 'done', content: finalText });
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
