// Access control for the shell. The shell can run arbitrary commands through the agent, so by default it only listens on
// loopback; exposing it (HOST=0.0.0.0) requires a way to sign in:
//   - 统一登录 (Casdoor OIDC): SUPERDEMO_OIDC_ISSUER + _CLIENT_ID + _CLIENT_SECRET + _ORGANIZATION — any account of
//     that Casdoor organization may sign in (no local user table); without the organization OIDC stays off;
//   - local fallback: the shared SUPERDEMO_PASSWORD (rate-limited), for when the IdP is down.
// Either opens a session: an HMAC-signed, HttpOnly, SameSite=Lax cookie. On https it is `__Host-sd_session` (Secure,
// Path=/, no Domain: bound to the shell's exact host, so demo-box.mmkj.site can neither receive nor plant it); on plain
// http (local development) `sd_session`. Project processes never see it (stripSessionCookie) and can't set it
// (dropForbiddenSetCookies). Without any sign-in method (loopback only), the Host header must be a loopback name
// (blocks DNS-rebinding). Writes from another origin are always refused (Sec-Fetch-Site / Origin), and API writes
// with a body must be JSON (a cross-site form can't send that).
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, ROOT, DATA_DIR, serverSecret } from './config.js';
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

/**
 * OIDC settings from the environment; null unless issuer, client id, secret AND organization are all set (without
 * the organization any account the IdP knows could sign in — that is refused, not assumed).
 */
export function oidcConfig() {
  const issuer = env('SUPERDEMO_OIDC_ISSUER').replace(/\/+$/, ''), clientId = env('SUPERDEMO_OIDC_CLIENT_ID'), clientSecret = env('SUPERDEMO_OIDC_CLIENT_SECRET');
  const organization = env('SUPERDEMO_OIDC_ORGANIZATION');
  if (!issuer || !clientId || !clientSecret || !organization) return null;
  return { issuer, clientId, clientSecret, internalUrl: env('SUPERDEMO_OIDC_INTERNAL_URL'), organization };
}
/** Half-configured OIDC (e.g. organization missing): a message for the startup log, else null. */
export function oidcProblem() {
  const keys = ['SUPERDEMO_OIDC_ISSUER', 'SUPERDEMO_OIDC_CLIENT_ID', 'SUPERDEMO_OIDC_CLIENT_SECRET', 'SUPERDEMO_OIDC_ORGANIZATION'];
  const missing = keys.filter(k => !env(k));
  return missing.length && missing.length < keys.length ? `统一登录未启用：缺少 ${missing.join(', ')}` : null;
}
export const authEnabled = () => passwordEnabled() || !!oidcConfig();

/** Refuse to start when listening beyond loopback without a way to sign in. Returns an error message or null. */
export function startupProblem() {
  if (isLoopbackHost(HOST) || authEnabled()) return null;
  return `HOST=${HOST} 会把 SuperDemo 暴露到网络上，而它可以通过 AI 在本机执行任意命令。\n` +
    `请设置登录方式：统一登录（SUPERDEMO_OIDC_ISSUER / _CLIENT_ID / _CLIENT_SECRET / _ORGANIZATION），或访问口令 SUPERDEMO_PASSWORD=<足够长的随机口令>。`;
}

// ---------- addresses ----------
const trustProxy = () => env('SUPERDEMO_TRUST_PROXY') === '1';
const hostOnly = h => String(h || '').toLowerCase().replace(/:\d+$/, ''); // "[::1]:3000" -> "[::1]"
const originOf = u => { try { return new URL(u).origin; } catch { return ''; } };
const forwardedHttps = req => trustProxy() && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
/** Secure cookies: TLS here, X-Forwarded-Proto https (only behind a trusted proxy), or an https public address. */
export function isSecure(req) {
  if (req.socket?.encrypted || forwardedHttps(req)) return true;
  return /^https:/.test(getSettings().publicUrl) && !isLoopbackHost(hostOnly(req.headers.host));
}
/** How the request looks from here (X-Forwarded-Proto / -Host only with SUPERDEMO_TRUST_PROXY=1). */
function requestOrigin(req) {
  const xfh = trustProxy() ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  return `${req.socket?.encrypted || forwardedHttps(req) ? 'https' : 'http'}://${xfh || req.headers.host || 'localhost'}`;
}
/** The shell's own addresses: public (relay), direct, plus SUPERDEMO_APP_ORIGINS. */
export function appOrigins() {
  const s = getSettings();
  return [...new Set([s.publicUrl, s.directUrl, ...list('SUPERDEMO_APP_ORIGINS')].map(originOf).filter(Boolean))];
}
export function clientIp(req) {
  if (trustProxy()) {
    const ip = String(req.headers['x-real-ip'] || '').trim() || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (ip) return ip;
  }
  return req.socket?.remoteAddress || '';
}

/**
 * Old host:port addresses (e.g. n7.mmkj.site:8788 / :8789 — both ports share one host name, so they share cookies):
 * once the public address of that server is configured, a request on any other non-loopback host is sent there, same
 * path + query. `kind` 'app': SUPERDEMO_PUBLIC_URL (hosts of SUPERDEMO_DIRECT_URL / _APP_ORIGINS are served);
 * 'demo': SUPERDEMO_DEMO_PUBLIC_URL (the direct demo host is served). Returns the target URL or null.
 */
export function legacyRedirect(req, kind) {
  const s = getSettings();
  const target = kind === 'demo' ? s.demoUrl : s.publicUrl;
  const host = String(req.headers.host || '').toLowerCase();
  if (!target || !host || isLoopbackHost(hostOnly(host))) return null;
  const served = kind === 'demo' ? [s.demoUrl, s.demoDirectUrl] : [s.publicUrl, s.directUrl, ...list('SUPERDEMO_APP_ORIGINS')];
  for (const u of served) {
    // a proxy that sends `Host: $host` drops the port: the host name alone matches
    try { const x = new URL(u); if (x.host.toLowerCase() === host || x.hostname.toLowerCase() === host) return null; } catch {}
  }
  return originOf(target) + (req.originalUrl || req.url || '/');
}
export const legacyMiddleware = kind => (req, res, next) => {
  const to = legacyRedirect(req, kind);
  if (to) return res.redirect(302, to);
  next();
};

// ---------- cookies ----------
const SESSION = 'sd_session', PENDING = 'sd_oidc';
const cookieName = (req, base) => (isSecure(req) ? `__Host-${base}` : base);
const PENDING_MS = 10 * 60_000;
const hours = (k, d) => (Number(env(k)) > 0 ? Number(env(k)) : d);
const OIDC_HOURS = () => hours('SUPERDEMO_SESSION_HOURS', 12);              // short: renewed silently through Casdoor
const PASSWORD_HOURS = () => hours('SUPERDEMO_PASSWORD_SESSION_HOURS', 24 * 7);

/** All values per cookie name (a name may appear more than once — e.g. a tossed cookie: try each). */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (k) (out[k] ||= []).push(part.slice(i + 1).trim());
  }
  return out;
}
const isShellCookie = name => /^(__Host-)?sd_(session|oidc)$/.test(name) || name.startsWith('__Host-');
/** The cookie header without the shell's sign-in cookies (what project processes may see). */
export function stripSessionCookie(header) {
  if (!header) return header;
  const kept = String(header).split(';').map(s => s.trim()).filter(s => s && !isShellCookie(s.split('=')[0].trim()));
  return kept.length ? kept.join('; ') : undefined;
}
/** A project's Set-Cookie headers minus those that could plant / overwrite the shell's cookies (or other hosts'). */
export function dropForbiddenSetCookies(v) {
  if (v === undefined) return v;
  const kept = (Array.isArray(v) ? v : [v]).filter(c => !isShellCookie(String(c).split('=')[0].trim()) && !/;\s*domain\s*=/i.test(String(c)));
  return kept.length ? kept : undefined;
}

// ---------- sessions: signed, plus a persisted global version (「全部登出」, bumped on a password change) and revocations ----------
const sessionSecret = () => env('SUPERDEMO_SESSION_SECRET') || serverSecret();
const key = () => crypto.createHmac('sha256', sessionSecret()).update('session').digest();
const pendingKey = () => crypto.createHmac('sha256', sessionSecret()).update('oidc-pending').digest();
const stateFile = () => path.join(DATA_DIR, 'auth-state.json');
let state = null;
function authState() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { state = {}; }
  state.version = Number.isInteger(state.version) ? state.version : 1;
  state.revoked = state.revoked && typeof state.revoked === 'object' ? state.revoked : {};
  // a new (or removed) password logs everyone out
  const fp = password() ? crypto.createHmac('sha256', sessionSecret()).update('pw\0' + password()).digest('base64url').slice(0, 16) : '';
  if ((state.pw ?? fp) !== fp) state.version++;
  state.pw = fp;
  saveState();
  return state;
}
function saveState() {
  const now = Date.now();
  for (const [k, exp] of Object.entries(state.revoked)) if (exp < now) delete state.revoked[k];
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 }); } catch (e) { console.warn('[auth] state:', e.message); }
}
/** 「全部登出」: every session issued so far stops working. */
export function logoutEverywhere() { authState().version++; saveState(); }
const makeSession = (via, who, h) => ({ sid: randomToken(12), v: authState().version, via, sub: who.sub || '', name: who.name || '', exp: Date.now() + h * 3_600_000 });
export function currentSession(req) {
  const st = authState();
  for (const value of parseCookies(req.headers.cookie)[cookieName(req, SESSION)] || []) {
    const s = unseal(value, key());
    if (!s || s.v !== st.version || st.revoked[s.sid]) continue;
    if (s.via === 'password' && !passwordEnabled()) continue; // a sign-in method that was switched off
    if (s.via === 'oidc' && !oidcConfig()) continue;
    return s;
  }
  return null;
}
const cookieOpts = (req, extra) => ({ httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', ...extra });
const setSessionCookie = (req, res, session) => res.cookie(cookieName(req, SESSION), seal(session, key()), cookieOpts(req, { expires: new Date(session.exp) }));
const clearSessionCookie = (req, res) => res.cookie(cookieName(req, SESSION), '', cookieOpts(req, { expires: new Date(0) }));

// ---------- request checks ----------
/** Cross-origin (or non-JSON API) write? null when fine, else { status, message }. */
export function writeProblem(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  // Sec-Fetch-Site is set by the browser and survives reverse proxies (which may rewrite Host): only same-origin
  // (or user-initiated, 'none') writes pass; a demo on demo-box.mmkj.site is 'same-site' -> refused
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return { status: 403, message: '拒绝跨站请求' };
  const origin = req.headers.origin;
  if (origin === 'null') return { status: 403, message: '拒绝跨站请求' }; // sandboxed pages (the legacy preview) included
  // browsers without Sec-Fetch-*: the Origin must be this host or one of the shell's own addresses
  if (origin && !sfs) {
    let o = null; try { o = new URL(origin); } catch {}
    if (!o || (o.host.toLowerCase() !== String(req.headers.host || '').toLowerCase() && !appOrigins().includes(o.origin))) return { status: 403, message: '拒绝跨站请求' };
  }
  // API writes carry JSON (or nothing); /p/ is the legacy preview, which proxies the demo's own forms
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
  const host = hostOnly(req.headers.host);
  if (!isLoopbackHost(host) && !extraHosts().has(host)) return { status: 403, message: `Host 不被允许: ${host}（如需通过其他域名访问，请设置登录方式：统一登录或 SUPERDEMO_PASSWORD）` };
  return null;
}

/** Shell pages may only be framed by the shell itself (clickjacking). */
export function frameGuard(req, res, next) {
  res.setHeader('content-security-policy', "frame-ancestors 'self'");
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  next();
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

// ---------- password login: rate limit ----------
// Per client address: 5 failures in 15 minutes lock that address. Overall: 30 failures in 15 minutes lock the
// password login for EVERYONE for the rest of the window (a distributed guess can't go on; 统一登录 keeps working).
const WINDOW_MS = 15 * 60_000, PER_IP = 5, GLOBAL = 30;
const fails = new Map(); // ip | '*' -> { n, since }
function limited(ip, now = Date.now()) {
  for (const k of [ip, '*']) { const f = fails.get(k); if (f && now - f.since > WINDOW_MS) fails.delete(k); }
  return (fails.get(ip)?.n || 0) >= PER_IP || (fails.get('*')?.n || 0) >= GLOBAL;
}
function recordFail(ip, now = Date.now()) {
  for (const k of [ip, '*']) { const f = fails.get(k) || { n: 0, since: now }; f.n++; fails.set(k, f); }
  if (fails.size > 10_000) { const g = fails.get('*'); fails.clear(); if (g) fails.set('*', g); }
}
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
 *   GET  /auth/oidc/callback   → state check, code exchange, ID token + userinfo + organization check → session → next
 *   POST /auth/logout          → ends the session; { sso: true } when the browser should also visit /auth/oidc/logout
 *   POST /auth/logout-all      → (signed in) 「全部登出」: every session, on every device
 *   GET  /auth/oidc/logout     → 302 to the IdP's end-session endpoint, which comes back to this site
 * `fetchFn` is injectable for tests (a mock IdP).
 */
export function authRouter({ fetchFn = (...a) => fetch(...a) } = {}) {
  const r = express.Router();
  const json = express.json({ limit: '10kb' });

  r.get('/login', (req, res) => {
    if (!authEnabled() || currentSession(req)) return res.redirect(302, safeNext(req.query.next));
    res.setHeader('cache-control', 'no-store');
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
    if (!cfg) return fail(res, 'not_configured', oidcProblem() || 'OIDC is not configured');
    const origin = siteOrigin(req);
    if (!origin) return fail(res, 'failed', `request origin ${requestOrigin(req)} is not among the site addresses (SUPERDEMO_PUBLIC_URL / SUPERDEMO_DIRECT_URL / SUPERDEMO_APP_ORIGINS)`);
    try {
      const doc = await discover(cfg, fetchFn);
      const pending = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), redirectUri: origin + '/auth/oidc/callback', next: safeNext(req.query.next), exp: Date.now() + PENDING_MS };
      // Lax: the IdP sends the browser back with a top-level GET, which Lax allows
      res.cookie(cookieName(req, PENDING), seal(pending, pendingKey()), cookieOpts(req, { maxAge: PENDING_MS }));
      res.redirect(302, authorizeUrl(doc, cfg, pending));
    } catch (e) { fail(res, 'failed', `discovery: ${e.message}`); }
  });

  r.get('/auth/oidc/callback', async (req, res) => {
    const cfg = oidcConfig();
    const pendings = (parseCookies(req.headers.cookie)[cookieName(req, PENDING)] || []).map(v => unseal(v, pendingKey())).filter(Boolean);
    res.cookie(cookieName(req, PENDING), '', cookieOpts(req, { expires: new Date(0) }));
    if (!cfg) return fail(res, 'not_configured', oidcProblem() || 'OIDC is not configured');
    if (typeof req.query.error === 'string') return fail(res, 'failed', `IdP error: ${String(req.query.error_description || req.query.error)}`);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!pendings.length) return fail(res, 'expired', 'pending cookie missing, forged or expired');
    const pending = state && pendings.find(p => sameString(state, p.state));
    if (!pending) return fail(res, 'expired', 'state mismatch');
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
    if (s) { authState().revoked[s.sid] = s.exp; saveState(); }
    clearSessionCookie(req, res);
    res.json({ ok: true, sso: s?.via === 'oidc' && !!oidcConfig() });
  });
  r.post('/auth/logout-all', (req, res) => {
    const bad = checkRequest(req);
    if (bad) return res.status(bad.status).json({ error: bad.message });
    const s = currentSession(req);
    logoutEverywhere();
    console.log(`[auth] 全部登出 by ${s?.name || 'local'}`);
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
