// Share links: /s/<token>/ opens one project's demo without the shell password. A visitor can only use that demo
// (same as the preview) — no conversation, code, settings or other projects. Links can expire and be revoked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'shares.json');
const VIEWS = path.join(DATA_DIR, 'share-views.jsonl'); // one line per page view: { t, k: token, v: visitor id, p: page }
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function writeAll(list) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 1)); }

const isLive = (s, now = Date.now()) => !s.revoked && (!s.expiresAt || s.expiresAt > now);

export function listShares(projectId) {
  const now = Date.now();
  return readAll().filter(s => s.projectId === projectId).map(s => ({ ...s, active: isLive(s, now) })).reverse();
}

/** days: number of days until expiry, 0 / empty = never. */
export function createShare(projectId, { days, label, feedback = true } = {}) {
  const d = Number(days);
  const share = {
    token: crypto.randomBytes(18).toString('base64url'),
    projectId,
    label: String(label || '').slice(0, 60),
    createdAt: Date.now(),
    expiresAt: d > 0 ? Date.now() + Math.min(d, 3650) * 86_400_000 : null,
    views: 0,
    lastViewAt: null,
    feedback: feedback !== false, // floating "提意见" button for visitors
  };
  writeAll([...readAll(), share]);
  return { ...share, active: true };
}

export function revokeShare(projectId, token) {
  const list = readAll();
  const s = list.find(x => x.token === token && x.projectId === projectId);
  if (!s) throw new Error('链接不存在');
  s.revoked = true;
  writeAll(list);
  return s;
}

export function deleteSharesOf(projectId) { writeAll(readAll().filter(s => s.projectId !== projectId)); }

/** The live share for a token, or null (unknown / revoked / expired). */
export function resolveShare(token) {
  if (!TOKEN_RE.test(token)) return null;
  const s = readAll().find(x => x.token === token);
  return s && isLive(s) ? s : null;
}

/** Count a page view (HTML documents only, not every asset request). */
export function recordView(token, visitor = '', page = '/') {
  const list = readAll();
  const s = list.find(x => x.token === token);
  if (!s) return;
  s.views = (s.views || 0) + 1; s.lastViewAt = Date.now();
  writeAll(list);
  appendLog({ t: Date.now(), k: token, v: String(visitor).slice(0, 32), p: String(page).slice(0, 120) });
}

/** Every write to the visit log goes through here, so it stays bounded (a hammered link must not fill the disk). */
function appendLog(row) {
  try {
    fs.appendFileSync(VIEWS, JSON.stringify(row) + '\n');
    // past 5 MB keep the newest half (checked on ~2% of writes)
    if (Math.random() < 0.02 && fs.statSync(VIEWS).size > 5_000_000) {
      const lines = fs.readFileSync(VIEWS, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(VIEWS, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch {}
}

/** Behaviour of share-link visitors, same log as views: e='a' = a write request (they actually did something:
 *  submit / save / book …), e='d' = visible time on a page (ms), sent by the injected script when the page is hidden. */
const eventRate = new Map();
export function recordEvent(token, visitor, e, data) {
  // per visitor and link: at most 60 events a minute (pings and writes); more is a script, not a person
  const k = token + ':' + visitor + ':' + Math.floor(Date.now() / 60_000);
  const n = (eventRate.get(k) || 0) + 1; eventRate.set(k, n);
  if (eventRate.size > 5000) eventRate.clear();
  if (n > 60) return;
  appendLog({ t: Date.now(), k: token, v: String(visitor).slice(0, 32), e, ...data });
}

export function setShareOptions(projectId, token, { feedback }) {
  const list = readAll();
  const s = list.find(x => x.token === token && x.projectId === projectId);
  if (!s) throw new Error('链接不存在');
  if (feedback !== undefined) s.feedback = !!feedback;
  writeAll(list);
  return s;
}

const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Visits of one link: totals, unique visitors, last `days` days, top pages. */
// the log is read for every board refresh: parse once per change of the file
let cache = { key: '', rows: [] };
function allRows() {
  let st; try { st = fs.statSync(VIEWS); } catch { return []; }
  const key = st.mtimeMs + ':' + st.size;
  if (cache.key !== key) {
    const rows = fs.readFileSync(VIEWS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    cache = { key, rows };
  }
  return cache.rows;
}

/** since: only events at or after this time (validation rounds count separately). */
export function shareStats(token, days = 14, since = 0) {
  const rows = allRows().filter(r => r.k === token && r.t >= since);
  const byDay = new Map(), pages = new Map(), visitors = new Set();
  const actors = new Set(), actions = new Map(), dwell = new Map(), inputs = [];
  for (const r of rows) {
    if (r.e === 'a') { actors.add(r.v); if (r.b) inputs.push(r.b); const k = String(r.a || '').replace(/\/\d+(?=\/|$)/g, '/:id'); actions.set(k, (actions.get(k) || 0) + 1); continue; }
    if (r.e === 'd') { dwell.set(r.v, (dwell.get(r.v) || 0) + Math.min(Number(r.ms) || 0, 1_800_000)); continue; }
    visitors.add(r.v);
    const k = dayKey(r.t), d = byDay.get(k) || { views: 0, visitors: new Set() };
    d.views++; d.visitors.add(r.v); byDay.set(k, d);
    pages.set(r.p, (pages.get(r.p) || 0) + 1);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(Date.now() - i * 86_400_000), d = byDay.get(k); series.push({ date: k, views: d?.views || 0, visitors: d?.visitors.size || 0 }); }
  const times = [...dwell.values()].sort((a, b) => a - b);
  const views = rows.filter(r => !r.e);
  return {
    actors: actors.size, inputs: inputs.slice(-20), actions: [...actions].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([action, count]) => ({ action, count })),
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null, timed: times.length,
    views: views.length, visitors: visitors.size, last: views.at(-1)?.t || null, days: series,
    pages: [...pages].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([page, views]) => ({ page, views })),
  };
}
