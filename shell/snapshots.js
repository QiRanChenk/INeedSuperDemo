// Per-turn code snapshots so a business user can undo what the AI did, plus a cheap file fingerprint used to detect
// whether a shell command actually changed anything.
// Scope = project code. Runtime data (data/, uploads/, SQLite files) is never snapshotted nor touched by a restore, so
// rolling back code does not lose records users entered in the demo. sdk/ is shell-owned and re-synced on start.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './registry.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.superdemo', 'sdk', 'data', 'uploads']);
const SKIP_FILE = name => name === '.DS_Store' || /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(name);
const MAX_SNAPSHOTS = 30;

const metaDir = id => path.join(projectDir(id), '.superdemo');
const snapRoot = id => path.join(metaDir(id), 'snapshots');
const indexFile = id => path.join(metaDir(id), 'snapshots.json');

/** Relative paths (posix) of every in-scope file. */
export function codeFiles(dir) {
  const out = [];
  (function walk(abs, rel) {
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { if (!(rel === '' ? SKIP_DIRS.has(ent.name) : ent.name === 'node_modules' || ent.name === '.git')) walk(path.join(abs, ent.name), r); }
      else if (ent.isFile() && !SKIP_FILE(ent.name)) out.push(r);
    }
  })(dir, '');
  return out.sort();
}

/** path -> "size:mtime" for in-scope files. */
export function fingerprint(id) {
  const dir = projectDir(id);
  const fp = new Map();
  for (const r of codeFiles(dir)) { try { const st = fs.statSync(path.join(dir, r)); fp.set(r, `${st.size}:${st.mtimeMs}`); } catch {} }
  return fp;
}

/** Files added / removed / modified between two fingerprints. */
export function diffFingerprints(a, b) {
  const changed = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(k);
  for (const k of a.keys()) if (!b.has(k)) changed.push(k);
  return changed;
}

function readIndex(id) { try { return JSON.parse(fs.readFileSync(indexFile(id), 'utf8')); } catch { return []; } }
function writeIndex(id, list) { fs.mkdirSync(metaDir(id), { recursive: true }); fs.writeFileSync(indexFile(id), JSON.stringify(list, null, 1)); }

export function listSnapshots(id) { return readIndex(id).slice().reverse(); }

/** Copy all in-scope files into a new snapshot. meta: { label, sid, kind, protect? } — protect: snapshot id never pruned here. */
export function createSnapshot(id, meta = {}) {
  const dir = projectDir(id);
  const sid = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const dest = path.join(snapRoot(id), sid);
  const files = codeFiles(dir);
  for (const r of files) {
    const to = path.join(dest, r);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, r), to);
  }
  const entry = { id: sid, ts: Date.now(), files: files.length, label: String(meta.label || '').slice(0, 120), session: meta.sid || null, kind: meta.kind || 'turn' };
  const list = readIndex(id);
  list.push(entry);
  // prune oldest beyond the cap
  while (list.length > MAX_SNAPSHOTS) {
    const i = list.findIndex(s => s.id !== meta.protect);
    const [old] = list.splice(i, 1);
    fs.rmSync(path.join(snapRoot(id), old.id), { recursive: true, force: true });
  }
  writeIndex(id, list);
  return entry;
}

export function deleteSnapshot(id, sid) {
  if (!/^v[a-z0-9]+$/.test(sid)) throw new Error('bad snapshot id');
  fs.rmSync(path.join(snapRoot(id), sid), { recursive: true, force: true });
  writeIndex(id, readIndex(id).filter(s => s.id !== sid));
}

/** Record what a turn changed on its snapshot (shown in the version list). */
export function annotateSnapshot(id, sid, patch) {
  const list = readIndex(id);
  const s = list.find(x => x.id === sid);
  if (s) { Object.assign(s, patch); writeIndex(id, list); }
}

/**
 * Restore project code to a snapshot: in-scope files not in the snapshot are deleted, the rest overwritten.
 * The current state is snapshotted first ("回滚前自动备份"), so a restore can itself be undone.
 */
export function restoreSnapshot(id, sid) {
  if (!/^v[a-z0-9]+$/.test(sid)) throw new Error('bad snapshot id');
  const target = readIndex(id).find(s => s.id === sid);
  if (!target) throw new Error('版本不存在');
  const src = path.join(snapRoot(id), sid);
  if (!fs.existsSync(src)) throw new Error('版本文件已丢失');
  const backup = createSnapshot(id, { label: `回滚到「${target.label || new Date(target.ts).toLocaleString()}」之前的状态`, kind: 'backup', protect: sid });
  const dir = projectDir(id);
  const keep = new Set(codeFiles(src));
  for (const r of codeFiles(dir)) if (!keep.has(r)) fs.rmSync(path.join(dir, r), { force: true });
  for (const r of keep) {
    const to = path.join(dir, r);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, r), to);
  }
  return { restored: target, backup };
}
