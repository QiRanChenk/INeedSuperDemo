// Sign-in: a throwaway shell (temp dirs, free ports) with 统一登录 against a mock OIDC provider (real HTTP, RSA-signed
// ID tokens) plus the shared-password fallback. Checks the login flows, the access check (401 / redirect / CSRF),
// that share links stay public, that the demo origin never forwards the session cookie to a project, and 直连.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { verifyIdToken, pickOrigin, safeNext, seal, unseal, serverSide } from '../shell/oidc.js';
import { stripSessionCookie } from '../shell/auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PASSWORD = 'correct horse battery staple';
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mock IdP ----------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, key = privateKey, kid = 'k1') {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid }), body = b64(claims);
  return `${head}.${body}.${crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
const idp = { port: 0, issuer: '', codes: new Map(), knobs: {}, server: null, tokenCalls: 0 };
const CLIENT = { id: 'demo-client', secret: 'demo-secret' };
function startIdp() {
  idp.server = http.createServer((req, res) => {
    const url = new URL(req.url, idp.issuer);
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, {
      issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/login/oauth/authorize`, token_endpoint: `${idp.issuer}/api/login/oauth/access_token`,
      userinfo_endpoint: `${idp.issuer}/api/userinfo`, jwks_uri: `${idp.issuer}/.well-known/jwks`, end_session_endpoint: `${idp.issuer}/api/logout`,
    });
    if (url.pathname === '/.well-known/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/api/login/oauth/access_token') {
      let body = ''; req.on('data', c => { body += c; });
      return req.on('end', () => {
        idp.tokenCalls++;
        const f = new URLSearchParams(body), c = idp.codes.get(f.get('code'));
        idp.codes.delete(f.get('code'));
        if (!c || f.get('client_id') !== CLIENT.id || f.get('client_secret') !== CLIENT.secret || f.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' });
        if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: idp.issuer, aud: CLIENT.id, sub: 'user-1', nonce: c.nonce, exp: now + 300, iat: now, owner: idp.knobs.owner ?? 'internal', email: 'ckj1@vip.qq.com', preferred_username: 'ckj' };
        json(200, { access_token: 'at-' + crypto.randomBytes(8).toString('hex'), id_token: idp.knobs.badKey ? sign(claims, other.privateKey) : sign(claims) });
      });
    }
    if (url.pathname === '/api/userinfo') return json(200, { sub: idp.knobs.userinfoSub ?? 'user-1', email: 'ckj1@vip.qq.com', preferred_username: 'ckj' });
    res.writeHead(404); res.end();
  });
  return new Promise(r => idp.server.listen(0, '127.0.0.1', () => { idp.port = idp.server.address().port; idp.issuer = `http://127.0.0.1:${idp.port}`; r(); }));
}
/** What the browser does at the IdP: the user signs in, the IdP issues a code for the authorize request. */
function authorize(location) {
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, `${idp.issuer}/login/oauth/authorize`);
  assert.equal(u.searchParams.get('client_id'), CLIENT.id);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const code = crypto.randomBytes(8).toString('hex');
  idp.codes.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), redirectUri: u.searchParams.get('redirect_uri') });
  return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri') };
}

// ---------- the shell ----------
let tmp, shell, PORT, DEMO_PORT, BASE, DEMO;
const cookiesOf = res => Object.fromEntries(res.headers.getSetCookie().map(c => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
const get = (p, opts = {}) => fetch(BASE + p, { redirect: 'manual', ...opts });
let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;
async function passwordLogin(pw = PASSWORD, ip = nextIp()) {
  return get('/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ password: pw, next: '/#/p/x' }) });
}
async function oidcLogin() {
  const start = await get('/auth/oidc/login?next=%2F%23%2Fp%2Fabc');
  assert.equal(start.status, 302);
  const pending = cookiesOf(start).sd_oidc;
  assert.ok(pending, 'pending cookie');
  const pc = start.headers.getSetCookie().find(c => c.startsWith('sd_oidc='));
  assert.match(pc, /Path=\/auth\/oidc;/); assert.match(pc, /HttpOnly/); assert.match(pc, /SameSite=Lax/);
  const a = authorize(start.headers.get('location'));
  assert.equal(a.redirectUri, `${BASE}/auth/oidc/callback`);
  return { pending, ...a };
}

before(async () => {
  await startIdp();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-auth-'));
  [PORT, DEMO_PORT] = [await freePort(), await freePort()];
  BASE = `http://127.0.0.1:${PORT}`; DEMO = `http://127.0.0.1:${DEMO_PORT}`;
  shell = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'shell/server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), SUPERDEMO_DEMO_PORT: String(DEMO_PORT), HOST: '127.0.0.1', SUPERDEMO_PASSWORD: PASSWORD,
      SUPERDEMO_OIDC_ISSUER: idp.issuer, SUPERDEMO_OIDC_CLIENT_ID: CLIENT.id, SUPERDEMO_OIDC_CLIENT_SECRET: CLIENT.secret, SUPERDEMO_OIDC_ORGANIZATION: 'internal',
      SUPERDEMO_TRUST_PROXY: '1', SUPERDEMO_PUBLIC_URL: BASE, SUPERDEMO_DIRECT_URL: `http://localhost:${PORT}`,
      SUPERDEMO_DEMO_PUBLIC_URL: DEMO, SUPERDEMO_DEMO_DIRECT_URL: `http://localhost:${DEMO_PORT}`,
      SUPERDEMO_PROJECTS_DIR: path.join(tmp, 'projects'), SUPERDEMO_DATA_DIR: path.join(tmp, 'data'), LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' },
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(150); }
});
after(() => { shell?.kill(); idp.server?.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ---------- protocol units ----------
test('ID token checks: signature, iss, aud, nonce, exp', () => {
  const now = Math.floor(Date.now() / 1000);
  const ok = { iss: 'https://auth.example', aud: 'c1', sub: 's', nonce: 'n1', exp: now + 60 };
  const opts = { issuer: 'https://auth.example', clientId: 'c1', nonce: 'n1', keys: [jwk] };
  assert.equal(verifyIdToken(sign(ok), opts).sub, 's');
  assert.throws(() => verifyIdToken(sign(ok, other.privateKey), opts), /签名无效/);
  assert.throws(() => verifyIdToken(sign({ ...ok, iss: 'https://evil' }), opts), /iss/);
  assert.throws(() => verifyIdToken(sign({ ...ok, aud: 'c2' }), opts), /aud/);
  assert.throws(() => verifyIdToken(sign({ ...ok, nonce: 'n2' }), opts), /nonce/);
  assert.throws(() => verifyIdToken(sign({ ...ok, exp: now - 600 }), opts), /过期/);
  assert.throws(() => verifyIdToken(sign(ok, privateKey, 'unknown'), opts), /公钥/);
});

test('redirect origin, next, sealed values, internal endpoint', () => {
  const allowed = ['https://demo.mmkj.site', 'https://demo6.mmkj.site:5002', 'https://n7.mmkj.site:8788'];
  assert.equal(pickOrigin('https://demo.mmkj.site', allowed), 'https://demo.mmkj.site');
  assert.equal(pickOrigin('http://demo6.mmkj.site', allowed), 'https://demo6.mmkj.site:5002'); // proxy dropped the port
  assert.equal(pickOrigin('https://evil.example', allowed), null);
  assert.equal(safeNext('//evil.example/x'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('/#/p/abc'), '/#/p/abc');
  const key = crypto.randomBytes(32), v = seal({ a: 1, exp: Date.now() + 1000 }, key);
  assert.equal(unseal(v, key).a, 1);
  assert.equal(unseal(v.replace(/^./, c => (c === 'a' ? 'b' : 'a')), key), null);
  assert.equal(unseal(seal({ exp: Date.now() - 1 }, key), key), null);
  const cfg = { issuer: 'https://auth.mmkj.site', internalUrl: 'http://192.168.123.227:8001' };
  assert.equal(serverSide('https://auth.mmkj.site/api/userinfo', cfg), 'http://192.168.123.227:8001/api/userinfo');
  assert.equal(serverSide('https://other.example/x', cfg), 'https://other.example/x');
});

test('session cookies never reach a project', () => {
  assert.equal(stripSessionCookie('sd_session=abc; sdpk=k; sdv=v'), 'sdpk=k; sdv=v');
  assert.equal(stripSessionCookie('sd_session=abc'), undefined);
  assert.equal(stripSessionCookie('a=1; sd_oidc=x; b=2'), 'a=1; b=2');
});

// ---------- the running shell ----------
test('without a session: API 401 (marked for the UI), pages go to the login page; public bits stay public', async () => {
  const api = await get('/api/projects');
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('x-sd-login'), '1');
  // a page navigation (raw request: fetch() sets its own Sec-Fetch-Mode)
  const page = await new Promise((ok, no) => http.get(`${BASE}/`, { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } }, r => { r.resume(); ok(r); }).on('error', no));
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/login?next=%2F');
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/boot.js')).status, 200);
  assert.equal((await get('/api/health')).status, 200);
  assert.deepEqual(await (await get('/api/direct')).json(), { url: `http://localhost:${PORT}` });
  const me = await (await get('/auth/me')).json();
  assert.deepEqual([me.authenticated, me.methods.oidc, me.methods.password], [false, true, true]);
  assert.equal((await get('/s/nosuchtoken/')).status, 302); // shell-origin share links go to the demo origin, no login
  assert.equal((await fetch(`${DEMO}/s/nosuchtoken/`)).status, 404);
  assert.equal((await fetch(`${DEMO}/api/projects`)).status, 404); // nothing of the shell on the demo origin
});

test('统一登录: code + PKCE + state + nonce, then the session opens the API', async () => {
  const { pending, code, state } = await oidcLogin();
  const cb = await get(`/auth/oidc/callback?code=${code}&state=${state}`, { headers: { cookie: `sd_oidc=${pending}` } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/#/p/abc');
  const set = cb.headers.getSetCookie().find(c => c.startsWith('sd_session='));
  assert.match(set, /Path=\/;/); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /Domain=/i); // host-only: demo-box.mmkj.site never gets it
  const cookie = `sd_session=${cookiesOf(cb).sd_session}`;
  assert.equal((await get('/api/projects', { headers: { cookie } })).status, 200);
  const me = await (await get('/auth/me', { headers: { cookie } })).json();
  assert.equal(me.via, 'oidc');
  assert.match(me.name, /ckj/);
  // logout: the session is gone, and the browser is told to end the IdP session too
  const out = await get('/auth/logout', { method: 'POST', headers: { cookie, origin: BASE, 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(await out.json(), { ok: true, sso: true });
  assert.equal((await get('/api/projects', { headers: { cookie } })).status, 401);
  const sso = await get('/auth/oidc/logout');
  assert.match(sso.headers.get('location'), new RegExp(`^${idp.issuer}/api/logout\\?client_id=${CLIENT.id}&post_logout_redirect_uri=`));
});

test('统一登录 refuses: wrong or missing state, forged key, userinfo of someone else, other organization', async () => {
  const fails = async (setup, code, want) => {
    const l = await oidcLogin();
    Object.assign(idp.knobs, setup);
    const r = await get(`/auth/oidc/callback?code=${l.code}&state=${code ? l.state : 'wrong'}`, { headers: { cookie: `sd_oidc=${l.pending}` } });
    idp.knobs = {};
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/login?oidc_error=${want}`);
    assert.equal(cookiesOf(r).sd_session, undefined);
  };
  const calls = idp.tokenCalls;
  await fails({}, false, 'expired');
  assert.equal(idp.tokenCalls, calls, 'no code exchange on a state mismatch');
  await fails({ badKey: true }, true, 'failed');
  await fails({ userinfoSub: 'someone-else' }, true, 'failed');
  await fails({ owner: 'customers' }, true, 'no_account');
  // no pending cookie at all (e.g. a forged callback link)
  const l = await oidcLogin();
  assert.equal((await get(`/auth/oidc/callback?code=${l.code}&state=${l.state}`)).headers.get('location'), '/login?oidc_error=expired');
  // IdP error text never reaches the browser
  const e = await get(`/auth/oidc/callback?error=access_denied&error_description=${encodeURIComponent('<b>x</b>')}`);
  assert.equal(e.headers.get('location'), '/login?oidc_error=failed');
});

test('password fallback: wrong / right, rate limit per address', async () => {
  assert.equal((await passwordLogin('nope')).status, 401);
  const ok = await passwordLogin();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, next: '/#/p/x' });
  const cookie = `sd_session=${cookiesOf(ok).sd_session}`;
  assert.equal((await get('/api/projects', { headers: { cookie } })).status, 200);
  const ip = nextIp();
  for (let i = 0; i < 5; i++) assert.equal((await passwordLogin('nope', ip)).status, 401);
  assert.equal((await passwordLogin(PASSWORD, ip)).status, 429); // locked even with the right password
  assert.equal((await passwordLogin()).status, 200);             // other addresses are not
  // login itself is CSRF-checked: not JSON, or from another site
  assert.equal((await get('/auth/password', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': nextIp() }, body: `password=${PASSWORD}` })).status, 415);
  assert.equal((await get('/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site', 'x-real-ip': nextIp() }, body: JSON.stringify({ password: PASSWORD }) })).status, 403);
});

test('CSRF: signed-in writes from another origin or as a form are refused', async () => {
  const cookie = `sd_session=${cookiesOf(await passwordLogin()).sd_session}`;
  const post = headers => get('/api/projects/plan', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post({ 'sec-fetch-site': 'same-site', origin: DEMO })).status, 403);   // the demo origin
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);                // old browser, other origin
  assert.equal((await post({ origin: 'null' })).status, 403);
  assert.equal((await get('/api/projects/plan', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post({ 'sec-fetch-site': 'same-origin', origin: BASE })).status, 400); // passes the check (empty description)
  assert.equal((await post({ origin: `http://localhost:${PORT}` })).status, 400);            // the direct address is ours too
});

test('share links work without login; the project never sees the session; 直连 switch on the relay demo address', async () => {
  const cookie = `sd_session=${cookiesOf(await passwordLogin()).sd_session}`;
  const json = { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const p = await (await get('/api/projects', { method: 'POST', headers: json, body: JSON.stringify({ name: 'auth', description: 'auth', type: 'web' }) })).json();
  assert.ok(p.id, JSON.stringify(p));
  // the project echoes the cookies it receives
  const dir = path.join(tmp, 'projects', p.id);
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).entry;
  fs.writeFileSync(path.join(dir, entry), `import http from 'node:http'; http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<html><head></head><body>COOKIE['+(q.headers.cookie||'')+']</body></html>')}).listen(process.env.PORT,'127.0.0.1');`);
  await get(`/api/projects/${p.id}/restart`, { method: 'POST', headers: json });
  const share = await (await get(`/api/projects/${p.id}/shares`, { method: 'POST', headers: json, body: '{}' })).json();
  assert.ok(share.token);
  let r, html;
  for (let i = 0; i < 50; i++) { r = await fetch(`${DEMO}/s/${share.token}/`, { headers: { cookie: 'sd_session=stolen; keep=1' } }); if (r.status === 200) break; await sleep(200); }
  html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /COOKIE\[keep=1\]/);
  assert.doesNotMatch(html, /sd_session/);
  // served on the relay demo address (127.0.0.1 here) -> the 直连 switch script, pointing at the direct demo address
  assert.match(html, new RegExp(`D="http://localhost:${DEMO_PORT}"`));
  // ...and not when served on the direct address itself
  assert.doesNotMatch(await (await fetch(`http://localhost:${DEMO_PORT}/s/${share.token}/`)).text(), /_sdmv/);
  // the visitor moving over keeps their id and is not counted twice
  const before = (await (await get(`/api/projects/${p.id}/shares/${share.token}/stats`, { headers: { cookie } })).json()).views;
  const moved = await fetch(`http://localhost:${DEMO_PORT}/s/${share.token}/?a=1&_sdmv=visitor12345`);
  assert.match(moved.headers.getSetCookie().join(';'), /sdv=visitor12345/);
  const after = (await (await get(`/api/projects/${p.id}/shares/${share.token}/stats`, { headers: { cookie } })).json()).views;
  assert.equal(after, before);
  // previews on the demo origin still need the project key, not the session
  assert.equal((await fetch(`${DEMO}/p/${p.id}/`, { headers: { cookie } })).status, 403);
  const s = await (await get('/api/settings', { headers: { cookie } })).json();
  assert.deepEqual([s.publicUrl, s.demoUrl, s.directUrl, s.demoDirectUrl, s.urlsLocked.demoUrl], [BASE, DEMO, `http://localhost:${PORT}`, `http://localhost:${DEMO_PORT}`, true]);
  await get(`/api/projects/${p.id}/stop`, { method: 'POST', headers: json });
});
