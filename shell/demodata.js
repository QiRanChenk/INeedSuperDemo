// Demo data snapshot: save the project's data/ (SQLite + files) as the "demo starting state" and put it back after
// visitors have played with it — on demand or automatically every day. The project is stopped while copying so the
// SQLite files are consistent.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readProject, writeProject } from './registry.js';
import * as runner from './runner.js';
import { checkpointAll } from './sqlite.js';

const dataDir = id => path.join(projectDir(id), 'data');
const saveDir = id => path.join(projectDir(id), '.superdemo', 'demo-data');
const metaFile = id => path.join(projectDir(id), '.superdemo', 'demo-data.json');
const SKIP = n => /\.(db-wal|db-shm)$/i.test(n);

export function demoDataInfo(id) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch {}
  const p = readProject(id);
  return { saved: meta, daily: p?.demoReset === 'daily', lastResetAt: p?.demoLastResetAt || null };
}

/** Run fn with the project stopped, restarting it afterwards if it was running. */
async function whileStopped(id, fn) {
  const wasRunning = !!runner.status(id).pid;
  if (wasRunning) await runner.stop(id);
  try { return fn(); } finally { if (wasRunning) await runner.start(id); }
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  if (!fs.existsSync(from)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  fs.cpSync(from, to, { recursive: true, filter: src => { if (SKIP(path.basename(src))) return false; try { const st = fs.statSync(src); if (st.isFile()) { files++; bytes += st.size; } } catch {} return true; } });
  return { files, bytes };
}

export async function saveDemoData(id) {
  const r = await whileStopped(id, () => { checkpointAll(dataDir(id)); return copyDir(dataDir(id), saveDir(id)); });
  const meta = { savedAt: Date.now(), ...r };
  fs.writeFileSync(metaFile(id), JSON.stringify(meta));
  return demoDataInfo(id);
}

export async function restoreDemoData(id) {
  if (!fs.existsSync(saveDir(id))) throw new Error('还没有保存演示数据');
  await whileStopped(id, () => copyDir(saveDir(id), dataDir(id)));
  const p = readProject(id);
  if (p) writeProject({ ...p, demoLastResetAt: Date.now() });
  return demoDataInfo(id);
}

export function setDailyReset(id, on) {
  const p = readProject(id);
  if (!p) throw new Error('project not found');
  writeProject({ ...p, demoReset: on ? 'daily' : 'off' });
  return demoDataInfo(id);
}

const RESET_HOUR = 4; // local time: restore once a day after 04:00
/** Called periodically: restores projects whose daily reset is due. isBusy(id) -> skip projects the agent is working on. */
export async function runDailyResets(projects, isBusy) {
  const now = new Date();
  if (now.getHours() < RESET_HOUR) return [];
  const today = new Date(now); today.setHours(RESET_HOUR, 0, 0, 0);
  const done = [];
  for (const p of projects) {
    if (p.demoReset !== 'daily' || (p.demoLastResetAt || 0) >= today.getTime() || isBusy(p.id) || !fs.existsSync(saveDir(p.id))) continue;
    try { await restoreDemoData(p.id); runner.log(p.id, 'sys', '[shell] 演示数据已按每日计划恢复'); done.push(p.id); }
    catch (e) { runner.log(p.id, 'sys', '[shell] daily demo data reset failed: ' + e.message); }
  }
  return done;
}
