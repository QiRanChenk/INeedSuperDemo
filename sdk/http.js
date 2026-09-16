import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

/**
 * Minimal router. Handlers: async (req, res, ctx) where ctx = { params, query, body, json(), text(), html() }.
 * Routes match paths WITHOUT a leading slash concern: register "api/hello" or "/api/hello", both fine.
 */
export function createApp() {
  const routes = [];
  let staticDir = null;
  let notFound = null;

  const add = method => (pattern, handler) => {
    const keys = [];
    const re = new RegExp('^/' + pattern.replace(/^\/+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
    return app;
  };

  const app = {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), patch: add('PATCH'),
    static(dir) { staticDir = dir; return app; },
    notFound(h) { notFound = h; return app; },
    async handle(req, res) {
      const url = new URL(req.url, 'http://x');
      const ctx = { params: {}, query: Object.fromEntries(url.searchParams), body: undefined,
        json: (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); },
        text: (s, status = 200) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(s); },
        html: (s, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); } };
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          r.keys.forEach((k, i) => ctx.params[k] = decodeURIComponent(m[i + 1]));
          if (['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readBody(req);
          return await r.handler(req, res, ctx);
        }
        if (staticDir && req.method === 'GET' && serveStatic(staticDir, url.pathname, res)) return;
        if (notFound) return await notFound(req, res, ctx);
        ctx.text('Not Found', 404);
      } catch (e) {
        console.error(`[${req.method} ${url.pathname}]`, e);
        if (!res.headersSent) ctx.json({ error: e.message }, 500);
        else res.end();
      }
    },
    listen(port = Number(process.env.PORT) || 3000, cb) {
      const server = http.createServer((req, res) => app.handle(req, res));
      server.listen(port, '0.0.0.0', () => { console.log(`listening on http://localhost:${port}`); cb?.(server); });
      return server;
    },
  };
  return app;
}

export function serveStatic(dir, pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.resolve(dir, '.' + rel);
  if (!abs.startsWith(path.resolve(dir))) return false;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
  return true;
}

export function readBody(req, limit = 10_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('invalid JSON body')); } }
      else if (ct.includes('application/x-www-form-urlencoded')) resolve(Object.fromEntries(new URLSearchParams(raw)));
      else resolve(raw);
    });
    req.on('error', reject);
  });
}
