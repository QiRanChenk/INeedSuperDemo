// Access control for the shell. The shell can run arbitrary commands through the agent, so by default it only listens on
// loopback; exposing it (HOST=0.0.0.0) requires SUPERDEMO_PASSWORD (HTTP Basic auth, any username).
// Without a password, the Host header must be a loopback name (blocks DNS-rebinding) and cross-origin writes are refused.
import crypto from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.SUPERDEMO_PASSWORD || '';
const EXTRA_HOSTS = new Set((process.env.SUPERDEMO_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

export const isLoopbackHost = h => LOOPBACK.has(String(h).toLowerCase());
export const passwordEnabled = () => !!PASSWORD;

/** Refuse to start when listening beyond loopback without a password. Returns an error message or null. */
export function startupProblem() {
  if (isLoopbackHost(HOST) || PASSWORD) return null;
  return `HOST=${HOST} 会把 SuperDemo 暴露到网络上，而它可以通过 AI 在本机执行任意命令。\n` +
    `请同时设置访问口令：SUPERDEMO_PASSWORD=<足够长的随机口令>（浏览器会弹出登录框，用户名随意）。`;
}

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function passwordOk(header) {
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return crypto.timingSafeEqual(digest(pass), digest(PASSWORD));
}
const hostname = h => String(h || '').toLowerCase().replace(/:\d+$/, '');

/** null when the request may proceed, else { status, message }. Shared by HTTP middleware and WebSocket upgrades. */
export function checkRequest(req) {
  if (PASSWORD) return passwordOk(req.headers.authorization) ? null : { status: 401, message: '需要登录' };
  const host = hostname(req.headers.host);
  if (!isLoopbackHost(host) && !EXTRA_HOSTS.has(host)) return { status: 403, message: `Host 不被允许: ${host}（如需通过其他域名访问，请设置 SUPERDEMO_PASSWORD）` };
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && req.method !== 'GET' && req.method !== 'HEAD') {
    let oh = ''; try { oh = new URL(origin).host.toLowerCase(); } catch {}
    if (oh !== String(req.headers.host).toLowerCase()) return { status: 403, message: '拒绝跨站请求' };
  }
  return null;
}

export function authMiddleware(req, res, next) {
  if (req.method === 'GET' && req.path === '/api/health') return next(); // container healthcheck; reveals nothing
  const bad = checkRequest(req);
  if (!bad) return next();
  if (bad.status === 401) {
    res.setHeader('www-authenticate', 'Basic realm="SuperDemo", charset="UTF-8"');
    return setTimeout(() => res.status(401).send(bad.message), 300); // slow down guessing
  }
  res.status(bad.status).send(bad.message);
}
