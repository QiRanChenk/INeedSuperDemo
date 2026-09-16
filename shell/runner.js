import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { getProjectLlm } from './config.js';
import { projectDir, readProject, syncSdk } from './registry.js';

const procs = new Map(); // id -> { proc, status, logs, startedAt }
const LOG_LIMIT = 500;

function entry(id) {
  if (!procs.has(id)) procs.set(id, { proc: null, status: 'stopped', logs: [], startedAt: null });
  return procs.get(id);
}

function log(id, stream, text) {
  const e = entry(id);
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    e.logs.push({ t: Date.now(), stream, line });
  }
  if (e.logs.length > LOG_LIMIT) e.logs.splice(0, e.logs.length - LOG_LIMIT);
}

export function status(id) {
  const e = entry(id);
  return { status: e.status, pid: e.proc?.pid ?? null, startedAt: e.startedAt };
}

export function logs(id) { return entry(id).logs; }

export function projectEnv(project) {
  const llm = getProjectLlm();
  return {
    ...process.env,
    PORT: String(project.port),
    SUPERDEMO_PROJECT_ID: project.id,
    SUPERDEMO_PROJECT_NAME: project.name,
    SUPERDEMO_LLM_BASE_URL: llm.baseUrl,
    SUPERDEMO_LLM_API_KEY: llm.apiKey,
    SUPERDEMO_LLM_MODEL: llm.model,
  };
}

export async function start(id) {
  const project = readProject(id);
  if (!project) throw new Error('project not found');
  const e = entry(id);
  if (e.proc) return status(id);

  const cwd = projectDir(id);
  try { syncSdk(id); } catch (e) { log(id, 'sys', '[shell] sdk sync failed: ' + e.message); }
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(cwd, project.entry)], {
    cwd,
    env: projectEnv(project),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  e.proc = proc;
  e.status = 'starting';
  e.startedAt = Date.now();
  log(id, 'sys', `[shell] starting ${project.entry} on port ${project.port} (pid ${proc.pid})`);

  proc.stdout.on('data', d => log(id, 'out', d));
  proc.stderr.on('data', d => log(id, 'err', d));
  proc.on('exit', (code, sig) => {
    log(id, 'sys', `[shell] exited code=${code} signal=${sig ?? ''}`);
    if (e.proc === proc) { e.proc = null; e.status = code === 0 || sig ? 'stopped' : 'crashed'; }
  });

  const ok = await waitForPort(project.port, 8000, () => e.proc !== proc);
  if (e.proc === proc) e.status = ok ? 'running' : 'crashed';
  if (!ok && e.proc === proc) log(id, 'sys', '[shell] port did not open within 8s');
  return status(id);
}

export function stop(id) {
  const e = entry(id);
  const proc = e.proc;
  if (!proc) { e.status = 'stopped'; return Promise.resolve(status(id)); }
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    proc.once('exit', () => { clearTimeout(timer); e.proc = null; e.status = 'stopped'; resolve(status(id)); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(timer); e.proc = null; e.status = 'stopped'; resolve(status(id)); }
  });
}

export async function restart(id) {
  await stop(id);
  return start(id);
}

export function runningIds() {
  return [...procs.entries()].filter(([, e]) => e.proc).map(([id]) => id);
}

export async function stopAll() {
  await Promise.all([...procs.keys()].map(stop));
}

export function waitForPort(port, timeoutMs = 8000, aborted = () => false) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tryOnce = () => {
      if (aborted()) return resolve(false);
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}
