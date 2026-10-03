import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { getProjectLlm } from './config.js';
import { projectDir, readProject, syncSdk } from './registry.js';

const procs = new Map(); // id -> { proc, status, logs, startedAt, want, crashes }
const LOG_LIMIT = 500;
const LOG_FILE_MAX = 512 * 1024;
const CRASH_WINDOW = 60_000, MAX_AUTO_RESTARTS = 3;

// Logs are mirrored to .superdemo/run.log (JSON lines, one rotation) so they survive a shell restart.
const logFile = id => path.join(projectDir(id), '.superdemo', 'run.log');
function loadLogs(id) {
  try {
    return fs.readFileSync(logFile(id), 'utf8').split('\n').slice(-LOG_LIMIT - 1)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function entry(id) {
  if (!procs.has(id)) procs.set(id, { proc: null, status: 'stopped', logs: loadLogs(id), startedAt: null, want: false, crashes: [] });
  return procs.get(id);
}

/** Append log lines. stream: out | err | sys | web (browser errors reported by the preview page). */
export function log(id, stream, text) {
  const e = entry(id);
  const added = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const l = { t: Date.now(), stream, line };
    e.logs.push(l); added.push(l);
  }
  if (e.logs.length > LOG_LIMIT) e.logs.splice(0, e.logs.length - LOG_LIMIT);
  if (!added.length) return;
  try {
    const f = logFile(id);
    if (fs.existsSync(f) && fs.statSync(f).size > LOG_FILE_MAX) fs.renameSync(f, f + '.1');
    fs.appendFileSync(f, added.map(l => JSON.stringify(l)).join('\n') + '\n');
  } catch {}
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
    HOST: '127.0.0.1', // only reachable through the shell proxy (which enforces the shell's access control)
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
  e.want = true;
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
    if (e.proc !== proc) return;
    const wasRunning = e.status === 'running';
    // killed by a signal we did not send (OOM killer, kill -9) counts as a crash; stop() clears `want` first
    e.proc = null; e.status = code === 0 || (sig && !e.want) ? 'stopped' : 'crashed';
    if (e.status === 'crashed' && wasRunning && e.want) autoRestart(id, e);
  });

  const ok = await waitForPort(project.port, 8000, () => e.proc !== proc);
  if (e.proc === proc) e.status = ok ? 'running' : 'crashed';
  if (!ok && e.proc === proc) log(id, 'sys', '[shell] port did not open within 8s');
  return status(id);
}

/** A project that crashed after a successful start is brought back, at most MAX_AUTO_RESTARTS times per minute. */
function autoRestart(id, e) {
  const now = Date.now();
  e.crashes = e.crashes.filter(t => now - t < CRASH_WINDOW);
  if (e.crashes.length >= MAX_AUTO_RESTARTS) { log(id, 'sys', `[shell] crashed ${e.crashes.length + 1} times within a minute, not restarting automatically`); return; }
  e.crashes.push(now);
  const delay = 1000 * e.crashes.length;
  log(id, 'sys', `[shell] crashed, restarting in ${delay / 1000}s`);
  setTimeout(() => { if (e.want && !e.proc) start(id).catch(err => log(id, 'sys', '[shell] auto restart failed: ' + err.message)); }, delay);
}

export function stop(id) {
  const e = entry(id);
  e.want = false;
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
