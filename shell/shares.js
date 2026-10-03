// Share links: /s/<token>/ opens one project's demo without the shell password. A visitor can only use that demo
// (same as the preview) — no conversation, code, settings or other projects. Links can expire and be revoked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'shares.json');
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function writeAll(list) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 1)); }

const isLive = (s, now = Date.now()) => !s.revoked && (!s.expiresAt || s.expiresAt > now);

export function listShares(projectId) {
  const now = Date.now();
  return readAll().filter(s => s.projectId === projectId).map(s => ({ ...s, active: isLive(s, now) })).reverse();
}

/** days: number of days until expiry, 0 / empty = never. */
export function createShare(projectId, { days, label } = {}) {
  const d = Number(days);
  const share = {
    token: crypto.randomBytes(18).toString('base64url'),
    projectId,
    label: String(label || '').slice(0, 60),
    createdAt: Date.now(),
    expiresAt: d > 0 ? Date.now() + Math.min(d, 3650) * 86_400_000 : null,
    views: 0,
    lastViewAt: null,
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
export function recordView(token) {
  const list = readAll();
  const s = list.find(x => x.token === token);
  if (!s) return;
  s.views = (s.views || 0) + 1; s.lastViewAt = Date.now();
  writeAll(list);
}
