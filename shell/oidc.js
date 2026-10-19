// 统一登录 (Casdoor, OpenID Connect) — the protocol half, no Express, so it can be tested on its own.
// Ported from the 邮件签名智能生成器 (server/oidc.ts). Authorization code flow + PKCE (S256) + state + nonce; the code is
// exchanged server-to-server with the client secret, the ID token is checked against the issuer's JWKS (signature,
// iss, aud, exp, nonce), then userinfo is read and must name the same subject.
//
// `internalUrl` (optional) is where this server sends the token and userinfo calls (e.g. http://192.168.123.227:8001
// on the LAN). Discovery and the JWKS — the things that decide which keys are trusted — always come from the public
// https issuer, never from the internal address. The issuer in the ID token must equal the public issuer.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

/** `code` is what the browser gets to see (a fixed set); the message (details) only goes to the server log. */
export const OIDC_CODES = ['failed', 'expired', 'no_account', 'disabled', 'not_configured'];
export class OidcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const trimSlash = s => String(s || '').replace(/\/+$/, '');

/** Where this server sends the token / userinfo calls: the public URL, or the same path on `internalUrl`. */
export function serverSide(endpoint, cfg) {
  const internal = trimSlash(cfg.internalUrl);
  if (!internal) return endpoint;
  const ep = new URL(endpoint);
  if (ep.origin !== new URL(trimSlash(cfg.issuer)).origin) return endpoint;
  return internal + ep.pathname + ep.search;
}

const discoveryCache = new Map();
const jwksCache = new Map();
const CACHE_MS = 60 * 60_000;
export function clearOidcCaches() { discoveryCache.clear(); jwksCache.clear(); }

async function getJson(fetchFn, url, init) {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`统一登录服务返回了非 JSON 内容（HTTP ${res.status}）`); }
  if (!res.ok) throw new Error(`统一登录服务出错：${String(body.error_description || body.error || body.msg || `HTTP ${res.status}`)}`);
  return body;
}

export async function discover(cfg, fetchFn = fetch) {
  const issuer = trimSlash(cfg.issuer);
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  // always from the public issuer, never from the internal address
  const doc = await getJson(fetchFn, `${issuer}/.well-known/openid-configuration`);
  if (trimSlash(doc.issuer) !== issuer) throw new Error(`发现文档的 issuer（${doc.issuer}）与配置的（${issuer}）不一致`);
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('发现文档缺少 authorization_endpoint / token_endpoint');
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

// ---------- PKCE / random values ----------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const pkceChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');

// ---------- signed cookie values (pending login: state, nonce, PKCE verifier; also used for the session) ----------
export function seal(obj, key) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
/** null when missing, tampered with or expired (`exp`, ms). */
export function unseal(value, key, now = Date.now()) {
  if (!value) return null;
  const [body, mac] = String(value).split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp < now) return null;
    return p;
  } catch { return null; }
}

export function sameString(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- redirect URI / next ----------
/**
 * The redirect URI must be one the IdP knows, so it is chosen from the allowed site addresses rather than built from
 * request headers. An exact origin match wins; otherwise a unique allowed address with the same host name (a reverse
 * proxy that sends `Host: $host` drops the port). null when nothing fits.
 */
export function pickOrigin(requestOrigin, allowed) {
  let req; try { req = new URL(requestOrigin); } catch { return null; }
  const list = allowed.map(a => { try { return new URL(String(a).trim()); } catch { return null; } }).filter(Boolean);
  const exact = list.find(u => u.origin === req.origin);
  if (exact) return exact.origin;
  let same = list.filter(u => u.hostname === req.hostname);
  if (req.port) same = same.filter(u => u.port === req.port);
  const origins = [...new Set(same.map(u => u.origin))];
  return origins.length === 1 ? origins[0] : null;
}

/** Only same-site relative paths survive as the post-login destination. */
export function safeNext(next) {
  const s = typeof next === 'string' ? next : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\r\n]/.test(s)) return '/';
  return s.slice(0, 500);
}

export function authorizeUrl(doc, cfg, p) {
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', pkceChallenge(p.verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export function endSessionUrl(doc, cfg, postLogoutRedirectUri) {
  if (!doc.end_session_endpoint) return null;
  const u = new URL(doc.end_session_endpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  return u.toString();
}

// ---------- ID token ----------
const b64json = part => JSON.parse(Buffer.from(part, 'base64url').toString());
const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};

export function verifyIdToken(idToken, opts) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('ID token 格式不对');
  const header = b64json(parts[0]), claims = b64json(parts[1]);
  const alg = ALGS[String(header.alg)];
  if (!alg) throw new Error(`不支持的 ID token 签名算法：${String(header.alg)}`);
  const kid = header.kid ? String(header.kid) : '';
  const candidates = opts.keys.filter(k => (!kid || k.kid === kid) && (!k.use || k.use === 'sig'));
  if (!candidates.length) throw new Error('找不到签名 ID token 的公钥（kid 不匹配）');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = Buffer.from(parts[2], 'base64url');
  const ok = candidates.some(jwk => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (alg.ec) return verify(alg.hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
      if (alg.pss) return verify(alg.hash, data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: { sha256: 32, sha384: 48, sha512: 64 }[alg.hash] }, sig);
      return verify(alg.hash, data, key, sig);
    } catch { return false; }
  });
  if (!ok) throw new Error('ID token 签名无效');
  const now = Math.floor((opts.now ?? Date.now()) / 1000), skew = opts.skewSec ?? 120;
  if (trimSlash(claims.iss) !== trimSlash(opts.issuer)) throw new Error('ID token 的 iss 不对');
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? '')];
  if (!aud.includes(opts.clientId)) throw new Error('ID token 的 aud 不是本系统');
  if (aud.length > 1 && claims.azp !== undefined && claims.azp !== opts.clientId) throw new Error('ID token 的 azp 不是本系统');
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new Error('ID token 已过期');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new Error('ID token 尚未生效');
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, opts.nonce)) throw new Error('ID token 的 nonce 不匹配');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token 缺少 sub');
  return claims;
}

async function jwks(doc, fetchFn, refresh = false) {
  if (!doc.jwks_uri) throw new Error('发现文档缺少 jwks_uri');
  const url = doc.jwks_uri; // public, like discovery — keys are never taken from the internal address
  const hit = jwksCache.get(url);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.keys;
  const body = await getJson(fetchFn, url);
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

// ---------- the callback ----------
/**
 * Exchanges the code, checks the ID token, reads userinfo. Throws with a readable (Chinese) message.
 * `cfg.organization` (optional): the Casdoor organization the account must belong to (claim `owner`, when present).
 */
export async function completeLogin(cfg, input, fetchFn = fetch, now = Date.now()) {
  const doc = await discover(cfg, fetchFn);
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
    client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: input.verifier,
  });
  const tok = await getJson(fetchFn, serverSide(doc.token_endpoint, cfg), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(),
  });
  if (tok.error) throw new Error(`换取令牌失败：${String(tok.error_description || tok.error)}`);
  const idToken = String(tok.id_token ?? ''), accessToken = String(tok.access_token ?? '');
  if (!idToken || !accessToken) throw new Error('统一登录没有返回 ID token / access token');
  const verifyOpts = { issuer: cfg.issuer, clientId: cfg.clientId, nonce: input.nonce, now };
  let claims;
  try { claims = verifyIdToken(idToken, { ...verifyOpts, keys: await jwks(doc, fetchFn) }); }
  catch (e) {
    if (!/公钥|签名无效/.test(e.message)) throw e; // keys may have been rotated since they were cached: retry once
    claims = verifyIdToken(idToken, { ...verifyOpts, keys: await jwks(doc, fetchFn, true) });
  }
  let info = {};
  if (doc.userinfo_endpoint) {
    info = await getJson(fetchFn, serverSide(doc.userinfo_endpoint, cfg), { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (info.sub !== undefined && String(info.sub) !== String(claims.sub)) throw new Error('userinfo 与 ID token 不是同一个用户');
  }
  if (claims.isForbidden === true || info.isForbidden === true) throw new OidcError('disabled', `account ${claims.sub} is forbidden at the IdP`);
  if (cfg.organization && typeof claims.owner === 'string' && claims.owner !== cfg.organization) {
    throw new OidcError('no_account', `account ${claims.sub} belongs to organization ${claims.owner}, not ${cfg.organization}`);
  }
  const pick = k => String(info[k] ?? claims[k] ?? '').trim();
  return {
    sub: String(claims.sub),
    email: pick('email').toLowerCase(),
    name: pick('name') || pick('preferred_username') || pick('displayName'),
    username: pick('preferred_username') || pick('name'),
  };
}
