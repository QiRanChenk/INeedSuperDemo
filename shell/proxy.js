import http from 'node:http';
import net from 'node:net';
import { readProject } from './registry.js';
import { status, start } from './runner.js';
import { resolveShare, recordView } from './shares.js';

const PATH_RE = /^\/p\/([a-z0-9-]+)(\/.*)?$/;
const SHARE_RE = /^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/;

/**
 * Reverse proxy: /p/:id/<path> -> http://127.0.0.1:<project.port>/<path>
 * Projects must use relative URLs so they work under the sub-path.
 * HTML pages get a tiny error reporter injected (see errorReporter) so the agent can see front-end errors; the
 * project files themselves are never modified, exported projects stay clean.
 */
export function proxyMiddleware(req, res) {
  const m = req.originalUrl.match(PATH_RE);
  if (!m) return res.status(404).send('bad proxy path');
  const [, id, rest] = m;
  if (rest === undefined) return res.redirect(302, `/p/${id}/`);
  const project = readProject(id);
  if (!project) return res.status(404).send('project not found');
  forward(req, res, project, rest, { prefix: `/p/${id}`, inject: true });
}

/**
 * Share links: /s/:token/<path> -> the shared project. Mounted before the shell's access control. A stopped project is
 * started on demand (the visitor sees the waiting page meanwhile). No error reporter: visitors cannot post to the shell.
 */
export function shareMiddleware(req, res) {
  const m = req.originalUrl.match(SHARE_RE);
  const share = m && resolveShare(m[1]);
  const project = share && readProject(share.projectId);
  if (!project) return res.status(404).send(messagePage('链接已失效', '这个分享链接不存在、已过期或已被关闭，请向分享者索取新链接。'));
  if (m[2] === undefined) return res.redirect(302, `/s/${m[1]}/`);
  const st = status(project.id).status;
  if (st !== 'running') {
    if (st !== 'starting') start(project.id).catch(() => {});
    return res.status(503).send(waitingPage(project, st === 'crashed' ? '暂时无法打开，正在重试…' : '正在启动，请稍候…', true));
  }
  forward(req, res, project, m[2], { prefix: `/s/${m[1]}`, inject: false, onPage: () => recordView(share.token) });
}

function forward(req, res, project, rest, { prefix, inject, onPage }) {
  const st = status(project.id).status;
  if (st !== 'running' && st !== 'starting') {
    return res.status(503).send(waitingPage(project, st));
  }
  const headers = { ...req.headers, host: `127.0.0.1:${project.port}`, 'x-forwarded-prefix': prefix };
  delete headers['accept-encoding']; // keep HTML uncompressed so the reporter can be injected
  delete headers.authorization;      // the shell's credentials are not the project's business
  const upstream = http.request({ host: '127.0.0.1', port: project.port, method: req.method, path: rest, headers }, up => {
    const isHtml = /text\/html/i.test(up.headers['content-type'] || '') && req.method === 'GET';
    if (isHtml && up.statusCode < 400) onPage?.();
    if (!isHtml || !inject || up.headers['content-encoding']) {
      res.status(up.statusCode);
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined) res.setHeader(k, v);
      return up.pipe(res);
    }
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('end', () => {
      const html = injectReporter(Buffer.concat(chunks).toString('utf8'), project.id);
      res.status(up.statusCode);
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && k !== 'content-length') res.setHeader(k, v);
      res.setHeader('content-length', Buffer.byteLength(html));
      res.end(html);
    });
    up.on('error', () => res.end());
  });
  upstream.on('error', err => {
    if (!res.headersSent) res.status(502).send(waitingPage(project, 'unreachable: ' + err.message));
    else res.end();
  });
  req.pipe(upstream);
}

/** Project + upstream path for an upgrade request on /p/:id/… (shell access already checked) or /s/:token/…. */
export function upgradeTarget(url) {
  const p = url.match(PATH_RE);
  if (p) return { project: readProject(p[1]), path: p[2] || '/' };
  const s = url.match(SHARE_RE);
  const share = s && resolveShare(s[1]);
  if (share) return { project: readProject(share.projectId), path: s[2] || '/' };
  return null;
}

/** WebSocket (or any HTTP upgrade) passthrough — raw TCP splice after replaying the request head. */
export function proxyUpgrade(req, socket, head, target = upgradeTarget(req.url)) {
  const project = target?.project;
  if (!project || status(project.id).status !== 'running') { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  const up = net.connect(project.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${target.path} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^host$/i.test(k)) lines.push(`Host: 127.0.0.1:${project.port}`);
      else if (!/^authorization$/i.test(k)) lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close); socket.on('error', close);
}

/** Insert the reporter as the first script of the page (before the project's own scripts run). */
export function injectReporter(html, id) {
  const tag = `<script>${errorReporter(id)}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = html.match(/<!doctype[^>]*>/i);
  return d ? html.slice(0, d.index + d[0].length) + tag + html.slice(d.index + d[0].length) : tag + html;
}

// Reports uncaught errors, unhandled rejections, console.error, failed resources and 5xx fetches to the shell.
function errorReporter(id) {
  return `(function(){var u='/api/projects/${id}/client-errors',n=0;
function s(k,m){if(n++>30)return;try{var b=JSON.stringify({kind:k,message:String(m).slice(0,1500),page:location.pathname.replace(/^\\/p\\/[^/]+/,'')});
if(navigator.sendBeacon)navigator.sendBeacon(u,new Blob([b],{type:'application/json'}));else fetch(u,{method:'POST',body:b,headers:{'content-type':'application/json'},keepalive:true});}catch(_){}}
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s('resource','资源加载失败: '+(t.src||t.href).replace(location.origin,''));return;}
s('error',(e.message||'Error')+(e.filename?' @ '+e.filename.replace(location.origin,'')+':'+e.lineno+':'+e.colno:'')+(e.error&&e.error.stack?'\\n'+String(e.error.stack).split('\\n').slice(1,4).join('\\n'):''));},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;s('promise',(r&&(r.stack||r.message))||String(r));});
var ce=console.error;console.error=function(){try{s('console',[].map.call(arguments,function(a){return a&&a.stack?a.stack:typeof a==='object'?JSON.stringify(a):String(a);}).join(' '));}catch(_){}return ce.apply(console,arguments);};
var f=window.fetch;if(f)window.fetch=function(){var a=arguments;return f.apply(this,a).then(function(r){if(r.status>=500)s('http','请求失败 '+r.status+' '+(a[0]&&a[0].url||a[0]));return r;});};})();`;
}

/** visitor: share-link wording (no internal status words). */
function waitingPage(project, st, visitor = false) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(project.name)}</title>
<body style="font-family:system-ui;background:#0f1117;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:40px">⏳</div>
<p>${visitor ? `<b>${escapeHtml(project.name)}</b> ${escapeHtml(st)}` : `项目 <b>${escapeHtml(project.name)}</b> 当前状态: ${escapeHtml(st)}`}</p><p style="color:#8b949e">页面将自动刷新</p></div></body>`;
}

function messagePage(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui;background:#0f1117;color:#c9d1d9;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:40px">🔗</div><h2>${escapeHtml(title)}</h2><p style="color:#8b949e">${escapeHtml(text)}</p></div></body>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
