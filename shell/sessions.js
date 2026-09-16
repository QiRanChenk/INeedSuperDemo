// Per-project chat sessions. Each session = one history file; the project code is shared across sessions.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './registry.js';

const DEFAULT_TITLE = '新会话';
const metaDir = id => path.join(projectDir(id), '.superdemo');
const sessionsDir = id => path.join(metaDir(id), 'sessions');
const indexFile = id => path.join(metaDir(id), 'sessions.json');
const legacyFile = id => path.join(metaDir(id), 'history.json');
const file = (id, sid) => { if (!/^[a-z0-9]+$/.test(sid)) throw new Error('bad session id'); return path.join(sessionsDir(id), sid + '.json'); };

function readIndex(id) {
  ensure(id);
  try { return JSON.parse(fs.readFileSync(indexFile(id), 'utf8')); } catch { return { current: null, list: [] }; }
}
function writeIndex(id, idx) { fs.writeFileSync(indexFile(id), JSON.stringify(idx, null, 2)); return idx; }

/** Create the index on first use; migrate the legacy single history.json into a "默认会话". */
function ensure(id) {
  if (fs.existsSync(indexFile(id))) return;
  fs.mkdirSync(sessionsDir(id), { recursive: true });
  const now = new Date().toISOString();
  const s = { id: 'default', title: '默认会话', createdAt: now, updatedAt: now };
  if (fs.existsSync(legacyFile(id))) fs.renameSync(legacyFile(id), file(id, 'default'));
  else fs.writeFileSync(file(id, 'default'), '[]');
  writeIndex(id, { current: 'default', list: [s] });
}

export function listSessions(id) {
  const idx = readIndex(id);
  return { current: idx.current, list: idx.list.map(s => ({ ...s, messages: countUserMessages(id, s.id) })) };
}

export function createSession(id, title = DEFAULT_TITLE) {
  const idx = readIndex(id);
  const now = new Date().toISOString();
  const s = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: String(title || DEFAULT_TITLE).slice(0, 60), createdAt: now, updatedAt: now };
  fs.writeFileSync(file(id, s.id), '[]');
  idx.list.push(s); idx.current = s.id;
  writeIndex(id, idx);
  return s;
}

export function renameSession(id, sid, title) {
  const idx = readIndex(id);
  const s = idx.list.find(x => x.id === sid); if (!s) throw new Error('session not found');
  s.title = String(title || DEFAULT_TITLE).slice(0, 60); s.manualTitle = true;
  writeIndex(id, idx); return s;
}

export function deleteSession(id, sid) {
  const idx = readIndex(id);
  if (!idx.list.some(x => x.id === sid)) throw new Error('session not found');
  try { fs.rmSync(file(id, sid)); } catch {}
  idx.list = idx.list.filter(x => x.id !== sid);
  if (!idx.list.length) { writeIndex(id, idx); return createSession(id).id; }
  if (idx.current === sid) idx.current = idx.list[idx.list.length - 1].id;
  writeIndex(id, idx); return idx.current;
}

export function setCurrentSession(id, sid) {
  const idx = readIndex(id);
  if (!idx.list.some(x => x.id === sid)) throw new Error('session not found');
  idx.current = sid; writeIndex(id, idx); return sid;
}

/** sid || current session id (creating one if needed). */
export function resolveSession(id, sid) {
  const idx = readIndex(id);
  if (sid) { if (!idx.list.some(x => x.id === sid)) throw new Error('session not found'); return sid; }
  if (idx.current && idx.list.some(x => x.id === idx.current)) return idx.current;
  return idx.list.length ? setCurrentSession(id, idx.list[0].id) : createSession(id).id;
}

export function loadHistory(id, sid) {
  sid = resolveSession(id, sid);
  try { return JSON.parse(fs.readFileSync(file(id, sid), 'utf8')); } catch { return []; }
}

export function saveHistory(id, sid, history) {
  sid = resolveSession(id, sid);
  fs.writeFileSync(file(id, sid), JSON.stringify(history, null, 2));
  const idx = readIndex(id);
  const s = idx.list.find(x => x.id === sid);
  if (s) {
    s.updatedAt = new Date().toISOString();
    if (!s.manualTitle && (s.title === DEFAULT_TITLE || s.title === '默认会话')) {
      const first = history.find(m => m.role === 'user' && !m.system);
      if (first) s.title = String(first.content).split('\n')[0].slice(0, 30);
    }
    writeIndex(id, idx);
  }
}

export function clearHistory(id, sid) { saveHistory(id, resolveSession(id, sid), []); }

function countUserMessages(id, sid) {
  try { return JSON.parse(fs.readFileSync(file(id, sid), 'utf8')).filter(m => m.role === 'user' && !m.system).length; } catch { return 0; }
}
