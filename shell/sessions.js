// Per-project chat sessions. Each session = one history file; the project code is shared across sessions.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './registry.js';

const DEFAULT_TITLE = '新会话';
const metaDir = id => path.join(projectDir(id), '.superdemo');
const sessionsDir = id => path.join(metaDir(id), 'sessions');
const indexFile = id => path.join(metaDir(id), 'sessions.json');
const legacyFile = id => path.join(metaDir(id), 'history.json');
// History is JSON lines (one message per line) so the agent can append instead of rewriting a multi-MB file per message.
const file = (id, sid) => { if (!/^[a-z0-9]+$/.test(sid)) throw new Error('bad session id'); return path.join(sessionsDir(id), sid + '.jsonl'); };
const legacyJson = (id, sid) => path.join(sessionsDir(id), sid + '.json');

/** Parse a history file: .jsonl (current) or a legacy pretty-printed JSON array. */
export function parseHistory(text) {
  const t = String(text).trimStart();
  if (t.startsWith('[')) return JSON.parse(t);
  const out = [];
  for (const line of t.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch {} } // a torn last line is skipped
  return out;
}
const toJsonl = history => history.map(m => JSON.stringify(m)).join('\n') + (history.length ? '\n' : '');

/** Read the raw message list; migrates a legacy .json session file to .jsonl on first access. */
function readRaw(id, sid) {
  const f = file(id, sid);
  try { return parseHistory(fs.readFileSync(f, 'utf8')); } catch {}
  const legacy = legacyJson(id, sid);
  if (!fs.existsSync(legacy)) return [];
  try {
    const h = parseHistory(fs.readFileSync(legacy, 'utf8'));
    fs.writeFileSync(f, toJsonl(h)); fs.rmSync(legacy);
    return h;
  } catch { return []; }
}

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
  if (fs.existsSync(legacyFile(id))) fs.renameSync(legacyFile(id), legacyJson(id, 'default')); // converted to .jsonl on first read
  else fs.writeFileSync(file(id, 'default'), '');
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
  fs.writeFileSync(file(id, s.id), '');
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
  fs.rmSync(file(id, sid), { force: true }); fs.rmSync(legacyJson(id, sid), { force: true });
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
  return readRaw(id, resolveSession(id, sid));
}

/** Rewrite the whole history (clear / migration). The agent loop uses appendHistory. */
export function saveHistory(id, sid, history) {
  sid = resolveSession(id, sid);
  fs.writeFileSync(file(id, sid), toJsonl(history));
  touch(id, sid, history.find(m => m.role === 'user' && !m.system));
}

/** Append one message. */
export function appendHistory(id, sid, message) {
  sid = resolveSession(id, sid);
  const f = file(id, sid);
  if (!fs.existsSync(f)) readRaw(id, sid); // migrate legacy .json before appending
  fs.appendFileSync(f, JSON.stringify(message) + '\n');
  touch(id, sid, message.role === 'user' && !message.system ? message : null);
}

/** Bump updatedAt; the first real user message names an untitled session. */
function touch(id, sid, firstUser) {
  const idx = readIndex(id);
  const s = idx.list.find(x => x.id === sid);
  if (!s) return;
  s.updatedAt = new Date().toISOString();
  if (firstUser && !s.manualTitle && (s.title === DEFAULT_TITLE || s.title === '默认会话')) s.title = String(firstUser.content).split('\n')[0].slice(0, 30);
  writeIndex(id, idx);
}

/** ISO time of the most recent chat activity across all sessions; null if the project has never been chatted with. Read-only (no index creation). */
export function lastChatAt(id) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexFile(id), 'utf8'));
    return idx.list.map(s => s.updatedAt).filter(Boolean).sort().pop() || null;
  } catch { return null; }
}

export function clearHistory(id, sid) { saveHistory(id, resolveSession(id, sid), []); }

function countUserMessages(id, sid) {
  return readRaw(id, sid).filter(m => m.role === 'user' && !m.system && !m.interjection).length;
}
