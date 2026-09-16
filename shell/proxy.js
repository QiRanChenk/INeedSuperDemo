import http from 'node:http';
import { readProject } from './registry.js';
import { status } from './runner.js';

/**
 * Reverse proxy: /p/:id/<path> -> http://127.0.0.1:<project.port>/<path>
 * Projects must use relative URLs so they work under the sub-path.
 */
export function proxyMiddleware(req, res) {
  const m = req.originalUrl.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
  if (!m) return res.status(404).send('bad proxy path');
  const [, id, rest] = m;
  if (rest === undefined) return res.redirect(302, `/p/${id}/`);

  const project = readProject(id);
  if (!project) return res.status(404).send('project not found');
  const st = status(id).status;
  if (st !== 'running' && st !== 'starting') {
    return res.status(503).send(waitingPage(project, st));
  }

  const upstream = http.request({
    host: '127.0.0.1',
    port: project.port,
    method: req.method,
    path: rest,
    headers: { ...req.headers, host: `127.0.0.1:${project.port}`, 'x-forwarded-prefix': `/p/${id}` },
  }, up => {
    res.status(up.statusCode);
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined) res.setHeader(k, v);
    up.pipe(res);
  });
  upstream.on('error', err => {
    if (!res.headersSent) res.status(502).send(waitingPage(project, 'unreachable: ' + err.message));
    else res.end();
  });
  req.pipe(upstream);
}

function waitingPage(project, st) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<body style="font-family:system-ui;background:#0f1117;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:40px">⏳</div>
<p>项目 <b>${escapeHtml(project.name)}</b> 当前状态: ${escapeHtml(st)}</p><p style="color:#8b949e">页面将自动刷新</p></div></body>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
