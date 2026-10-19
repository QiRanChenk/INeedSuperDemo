// Access control for the shell. The shell can run arbitrary commands through the agent, so by default it only listens on
// loopback; exposing it (HOST=0.0.0.0) requires a way to sign in:
//   - 统一登录 (Casdoor OIDC): SUPERDEMO_OIDC_ISSUER + SUPERDEMO_OIDC_CLIENT_ID + SUPERDEMO_OIDC_CLIENT_SECRET — any
//     account of the Casdoor application's organization may sign in (no local user table);
//   - local fallback: the shared SUPERDEMO_PASSWORD (rate-limited), for when the IdP is down.
// Either opens a session: an HMAC-signed, HttpOnly, SameSite=Lax, host-only cookie on the shell's own host name (no
// Domain attribute, so demo-box.mmkj.site never receives it; on the old host:port setup, where both ports share the
// host name, the demo proxy strips it, see stripSessionCookie). Without any sign-in method (loopback only), the Host
// header must be a loopback name (blocks DNS-rebinding). Writes from another origin are always refused
// (Sec-Fetch-Site / Origin), and API writes with a body must be JSON (a cross-site form can't send that).
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, ROOT, serverSecret } from './config.js';
import { OidcError, OIDC_CODES, authorizeUrl, completeLogin, discover, endSessionUrl, pickOrigin, randomToken, safeNext, sameString, seal, unseal } from './oidc.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const HOST = process.env.HOST || '127.0.0.1';
// read on every use (tests change the environment between cases)
const env = k => String(process.env[k] || '').trim();
const password = () => process.env.SUPERDEMO_PASSWORD || '';
const extraHosts = () => new Set(env('SUPERDEMO_ALLOWED_HOSTS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const list = k => env(k).split(/[\s,]+/).map(s => s.replace(/\/+$/, '')).filter(Boolean);

export const isLoopbackHost = h => LOOPBACK.has(String(h).toLowerCase());
export const passwordEnabled = () => !!password();

/** OIDC settings from the environment; null unless issuer, client id and secret are all set. */
export function oidcConfig() {
  const issuer = env('SUPERDEMO_OIDC_ISSUER').replace(/\/+$/, ''), clientId = env('SUPERDEMO_OIDC_CLIENT_ID'), clientSecret = env('SUPERDEMO_OIDC_CLIENT_SECRET');
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, internalUrl: env('SUPERDEMO_OIDC_INTERNAL_URL'), organization: env('SUPERDEMO_OIDC_ORGANIZATION') };
}
export const authEnabled = () => passwordEnabled() || !!oidcConfig();

/** Refuse to start when listening beyond loopback without a way to sign in. Returns an error message or null. */
export function startupProblem() {
  if (isLoopbackHost(HOST) || authEnabled()) return null;
  return `HOST=${HOST} 会把 SuperDemo 暴露到网络上，而它可以通过 AI 在本机执行任意命令。\n` +
    `请设置登录方式：统一登录（SUPERDEMO_OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET），或访问口令 SUPERDEMO_PASSWORD=<足够长的随机口令>。`;
}

// ---------- cookies / addresses ----------
export const SESSION_COOKIE = 'sd_session';
const PENDING_COOKIE = 'sd_oidc';
const PENDING_PATH = '/auth/oidc';
const PENDING_MS = 10 * 60_000;
const hours = (k, d) => (Number(env(k)) > 0 ? Number(env(k)) : d);
const OIDC_HOURS = () => hours('SUPERDEMO_SESSION_HOURS', 12);              // short: renewed silently through Casdoor
const PASSWORD_HOURS = () => hours('SUPERDEMO_PASSWORD_SESSION_HOURS', 24 * 7);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}
/** The cookie header without the shell's sign-in cookies (what project processes may see). */
export function stripSessionCookie(header) {
  if (!header) return header;
  const kept = String(header).split(';').map(s => s.trim()).filter(s => s && !s.startsWith(SESSION_COOKIE + '=') && !s.startsWith(PENDING_COOKIE + '='));
  return kept.length ? kept.join('; ') : undefined;
}
const trustProxy = () => env('SUPERDEMO_TRUST_PROXY') === '1';
const isSecure = req => !!req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const hostname = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
/** How the request looks from here (X-Forwarded-Proto / -Host only with SUPERDEMO_TRUST_PROXY=1). */
function requestOrigin(req) {
  const xfh = trustProxy() ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const proto = (trustProxy() ? isSecure(req) : !!req.socket?.encrypted) ? 'https' : 'http';
  return `${proto}://${xfh || req.headers.host || 'localhost'}`;
}
/** The shell's own addresses: public (relay), direct, plus SUPERDEMO_APP_ORIGINS (e.g. the old https://n7.mmkj.site:8788). */
export function appOrigins() {
  const s = getSettings();
  const origin = u => { try { return new URL(u).origin; } catch { return ''; } };
  return [...new Set([s.publicUrl, s.directUrl, ...list('SUPERDEMO_APP_ORIGINS')].map(origin).filter(Boolean))];
}
export function clientIp(req) {
  if (trustProxy()) {
    const ip = String(req.headers['x-real-ip'] || '').trim() || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) return ip;
  }
  return req.socket?.remoteAddress || '';
}

// ---------- sessions (stateless, signed; the key changes with the password, so a new password logs everyone out) ----------
const key = () => crypto.createHmac('sha256', serverSecret()).update('session\0' + password()).digest();
const revoked = new Map(); // sid -> exp (logged out before expiry; in memory — sessions are short)
const makeSession = (via, who, h) => ({ sid: randomToken(12), via, sub: who.sub || '', name: who.name || '', exp: Date.now() + h * 3_600_000 });
export function currentSession(req) {
  const s = unseal(parseCookies(req.headers.cookie)[SESSION_COOKIE], key());
  if (!s || revoked.has(s.sid)) return null;
  if (s.via === 'password' && !passwordEnabled()) return null; // a sign-in method that was switched off
  if (s.via === 'oidc' && !oidcConfig()) return null;
  return s;
}
function setSessionCookie(req, res, session) {
  res.cookie(SESSION_COOKIE, seal(session, key()), { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', expires: new Date(session.exp) });
}
function clearSessionCookie(req, res) {
  res.cookie(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', expires: new Date(0) });
}

// ---------- request checks ----------
/** Cross-origin (or non-JSON API) write? null when fine, else { status, message }. */
export function writeProblem(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  // Sec-Fetch-Site is set by the browser and survives reverse proxies (which may rewrite Host): only same-origin
  // (or user-initiated, 'none') writes pass; a demo on the other port / on demo-box.mmkj.site is 'same-site' -> refused
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return { status: 403, message: '拒绝跨站请求' };
  const origin = req.headers.origin;
  if (origin === 'null') return { status: 403, message: '拒绝跨站请求' };
  // browsers without Sec-Fetch-*: the Origin must be this host or one of the shell's own addresses
  if (origin && !sfs) {
    let o = null; try { o = new URL(origin); } catch {}
    if (!o || (o.host.toLowerCase() !== String(req.headers.host || '').toLowerCase() && !appOrigins().includes(o.origin))) return { status: 403, message: '拒绝跨站请求' };
  }
  // API writes carry JSON (or nothing); /p/ is the legacy same-origin preview, which proxies the demo's own forms
  const url = req.originalUrl || req.url || '';
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (hasBody && !url.startsWith('/p/') && !/^application\/([\w.-]+\+)?json\b/i.test(String(req.headers['content-type'] || ''))) return { status: 415, message: '只接受 JSON 请求' };
  return null;
}

/** null when the request may proceed, else { status, message }. Shared by HTTP middleware and WebSocket upgrades. */
export function checkRequest(req) {
  const bad = writeProblem(req);
  if (bad) return bad;
  if (authEnabled()) return currentSession(req) ? null : { status: 401, message: '需要登录' };
  const host = hostname(req.headers.host);
  if (!isLoopbackHost(host) && !extraHosts().has(host)) return { status: 403, message: `Host 不被允许: ${host}（如需通过其他域名访问，请设置登录方式：统一登录或 SUPERDEMO_PASSWORD）` };
  return null;
}

export function authMiddleware(req, res, next) {
  if (req.method === 'GET' && (req.path === '/api/health' || req.path === '/api/direct')) return next(); // reveal nothing
  const bad = checkRequest(req);
  if (!bad) return next();
  if (bad.status === 401) {
    res.setHeader('cache-control', 'no-store');
    // page navigations go to the login page; background requests get a plain 401 (x-sd-login tells the UI to go there)
    const mode = req.headers['sec-fetch-mode'];
    if (req.method === 'GET' && (mode === 'navigate' || (!mode && /text\/html/.test(req.headers.accept || '')))) return res.redirect(302, '/login?next=' + encodeURIComponent(safeNext(req.originalUrl)));
    res.setHeader('x-sd-login', '1');
    return res.status(401).json({ error: bad.message });
  }
  res.status(bad.status).json({ error: bad.message });
}

// ---------- password login: rate limit (per client address, and overall) ----------
const WINDOW_MS = 15 * 60_000, PER_IP = 5, GLOBAL = 30;
const fails = new Map(); // ip | '*' -> { n, since }
function limited(ip, now = Date.now()) {
  for (const k of [ip, '*']) { const f = fails.get(k); if (f && now - f.since > WINDOW_MS) fails.delete(k); }
  return (fails.get(ip)?.n || 0) >= PER_IP || (fails.get('*')?.n || 0) >= GLOBAL;
}
function recordFail(ip, now = Date.now()) {
  for (const k of [ip, '*']) { const f = fails.get(k) || { n: 0, since: now }; f.n++; fails.set(k, f); }
  if (fails.size > 10_000) fails.clear();
}
export function resetLoginLimits() { fails.clear(); revoked.clear(); }
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = given => passwordEnabled() && crypto.timingSafeEqual(digest(given), digest(password()));

// ---------- OIDC: which site address the IdP sends the browser back to ----------
function siteOrigin(req) {
  const reqOrigin = requestOrigin(req);
  const picked = pickOrigin(reqOrigin, [...appOrigins(), ...list('SUPERDEMO_OIDC_REDIRECT_ORIGINS')]);
  if (picked) return picked;
  try { const u = new URL(reqOrigin); if (isLoopbackHost(u.hostname)) return u.origin; } catch {} // local development
  return null;
}
const pendingKey = () => crypto.createHmac('sha256', serverSecret()).update('oidc-pending').digest();
/** Details to the log, a fixed code to the browser. */
function fail(res, code, detail) {
  console.warn(`[oidc] login failed (${code}): ${detail}`);
  res.redirect(302, `/login?oidc_error=${OIDC_CODES.includes(code) ? code : 'failed'}`);
}

/**
 * Sign-in routes, mounted before the access check:
 *   GET  /login                → the login page (统一账号 / 访问口令)
 *   GET  /auth/me              → { enabled, authenticated, via, name, methods }
 *   POST /auth/password        → { password, next } (JSON) → session
 *   GET  /auth/oidc/login      → 302 to the IdP (state + nonce + PKCE in a signed, HttpOnly, 10-minute cookie)
 *   GET  /auth/oidc/callback   → state check, code exchange, ID token + userinfo check → session → next
 *   POST /auth/logout          → ends the session; { sso: true } when the browser should also visit /auth/oidc/logout
 *   GET  /auth/oidc/logout     → 302 to the IdP's end-session endpoint, which comes back to this site
 * `fetchFn` is injectable for tests (a mock IdP).
 */
export function authRouter({ fetchFn = (...a) => fetch(...a) } = {}) {
  const r = express.Router();
  const json = express.json({ limit: '10kb' });

  r.get('/login', (req, res) => {
    if (!authEnabled() || currentSession(req)) return res.redirect(302, safeNext(req.query.next));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-frame-options', 'DENY');
    res.type('html').send(fs.readFileSync(path.join(ROOT, 'shell', 'ui', 'login.html'), 'utf8'));
  });
  r.get('/auth/me', (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const s = currentSession(req);
    res.json({ enabled: authEnabled(), authenticated: !authEnabled() || !!s, via: s?.via || null, name: s?.name || '', methods: { oidc: !!oidcConfig(), password: passwordEnabled() } });
  });

  r.post('/auth/password', json, (req, res) => {
    const bad = writeProblem(req);
    if (bad) return res.status(bad.status).json({ error: bad.message });
    if (!passwordEnabled()) return res.status(404).json({ error: '未启用访问口令登录' });
    const ip = clientIp(req);
    if (limited(ip)) { console.warn(`[auth] password login rate-limited (${ip})`); return res.status(429).json({ error: '尝试次数太多，请 15 分钟后再试' }); }
    if (!passwordOk(String(req.body?.password ?? ''))) {
      recordFail(ip);
      console.warn(`[auth] wrong password (${ip})`);
      return setTimeout(() => res.status(401).json({ error: '口令不对' }), 400);
    }
    fails.delete(ip);
    setSessionCookie(req, res, makeSession('password', { name: '口令登录' }, PASSWORD_HOURS()));
    res.json({ ok: true, next: safeNext(req.body?.next) });
  });

  r.get('/auth/oidc/login', async (req, res) => {
    const cfg = oidcConfig();
    if (!cfg) return fail(res, 'not_configured', 'OIDC is not configured');
    const origin = siteOrigin(req);
    if (!origin) return fail(res, 'failed', `request origin ${requestOrigin(req)} is not among the site addresses (SUPERDEMO_PUBLIC_URL / SUPERDEMO_DIRECT_URL / SUPERDEMO_APP_ORIGINS)`);
    try {
      const doc = await discover(cfg, fetchFn);
      const pending = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), redirectUri: origin + '/auth/oidc/callback', next: safeNext(req.query.next), exp: Date.now() + PENDING_MS };
      res.cookie(PENDING_COOKIE, seal(pending, pendingKey()), {
        httpOnly: true, sameSite: 'lax', // the IdP sends the browser back with a top-level GET, which Lax allows
        secure: isSecure(req) || origin.startsWith('https:'), path: PENDING_PATH, maxAge: PENDING_MS,
      });
      res.redirect(302, authorizeUrl(doc, cfg, pending));
    } catch (e) { fail(res, 'failed', `discovery: ${e.message}`); }
  });

  r.get('/auth/oidc/callback', async (req, res) => {
    const cfg = oidcConfig();
    const pending = unseal(parseCookies(req.headers.cookie)[PENDING_COOKIE], pendingKey());
    res.cookie(PENDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: PENDING_PATH, expires: new Date(0) });
    if (!cfg) return fail(res, 'not_configured', 'OIDC is not configured');
    if (typeof req.query.error === 'string') return fail(res, 'failed', `IdP error: ${String(req.query.error_description || req.query.error)}`);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!pending) return fail(res, 'expired', 'pending cookie missing, forged or expired');
    if (!state || !sameString(state, pending.state)) return fail(res, 'expired', 'state mismatch');
    if (!code) return fail(res, 'failed', 'no authorization code');
    try {
      const id = await completeLogin(cfg, { code, redirectUri: pending.redirectUri, verifier: pending.verifier, nonce: pending.nonce }, fetchFn);
      const name = id.username && id.email && id.username !== id.email ? `${id.username}（${id.email}）` : id.email || id.username || id.name || id.sub;
      console.log(`[oidc] signed in: ${name} (${id.sub})`);
      setSessionCookie(req, res, makeSession('oidc', { sub: id.sub, name }, OIDC_HOURS()));
      res.redirect(302, pending.next);
    } catch (e) { fail(res, e instanceof OidcError ? e.code : 'failed', e.message); }
  });

  r.post('/auth/logout', (req, res) => {
    const bad = writeProblem(req);
    if (bad) return res.status(bad.status).json({ error: bad.message });
    const s = currentSession(req);
    if (s) { const now = Date.now(); for (const [k, exp] of revoked) if (exp < now) revoked.delete(k); revoked.set(s.sid, s.exp); }
    clearSessionCookie(req, res);
    res.json({ ok: true, sso: s?.via === 'oidc' && !!oidcConfig() });
  });
  r.get('/auth/oidc/logout', async (req, res) => {
    const cfg = oidcConfig(), origin = siteOrigin(req);
    if (!cfg || !origin) return res.redirect(302, '/login?signed_out=1');
    try { res.redirect(302, endSessionUrl(await discover(cfg, fetchFn), cfg, `${origin}/`) ?? '/login?signed_out=1'); }
    catch { res.redirect(302, '/login?signed_out=1'); }
  });
  return r;
}
