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
  try { fs.appendFileSync(VIEWS, JSON.stringify({ t: Date.now(), k: token, v: String(visitor).slice(0, 32), p: String(page).slice(0, 120) }) + '\n'); } catch {}
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
export function shareStats(token, days = 14) {
  let rows = [];
  try { rows = fs.readFileSync(VIEWS, 'utf8').split('\n').filter(l => l.includes(token)).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.k === token); } catch {}
  const byDay = new Map(), pages = new Map(), visitors = new Set();
  for (const r of rows) {
    visitors.add(r.v);
    const k = dayKey(r.t), d = byDay.get(k) || { views: 0, visitors: new Set() };
    d.views++; d.visitors.add(r.v); byDay.set(k, d);
    pages.set(r.p, (pages.get(r.p) || 0) + 1);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(Date.now() - i * 86_400_000), d = byDay.get(k); series.push({ date: k, views: d?.views || 0, visitors: d?.visitors.size || 0 }); }
  return {
    views: rows.length, visitors: visitors.size, last: rows.at(-1)?.t || null, days: series,
    pages: [...pages].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([page, views]) => ({ page, views })),
  };
}
