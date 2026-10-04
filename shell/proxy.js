import http from 'node:http';
import net from 'node:net';
import { readProject } from './registry.js';
import { status, start } from './runner.js';
import crypto from 'node:crypto';
import { resolveShare, recordView, recordEvent } from './shares.js';
import { feedbackScript } from './feedback-widget.js';
import { notifyFeedback } from './notify.js';
import { addFeedback } from './feedback.js';
import { getTour, tourScript } from './tour.js';
import { checkRequest } from './auth.js';

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
  if (m[2].startsWith('/__sd/feedback')) return handleFeedback(req, res, share);
  // the owner previewing via 「打开看看」 (?_sdself=1, remembered in a cookie for this link) is not counted as a visitor
  // (only honoured for the owner: a request that would pass the shell's own access check)
  const asksSelf = /[?&]_sdself=1\b/.test(m[2] || '') && !checkRequest(req);
  const self = asksSelf || (/(?:^|;\s*)sdself=1/.test(req.headers.cookie || '') && !checkRequest(req));
  if (asksSelf) res.appendHeader('set-cookie', `sdself=1; Path=/s/${m[1]}/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  const visitorId = self ? null : /(?:^|;\s*)sdv=([A-Za-z0-9_-]{8,32})/.exec(req.headers.cookie || '')?.[1];
  if (m[2].startsWith('/__sd/ping')) return handlePing(req, res, share, visitorId);
  // a visitor who sends a write request has actually used the demo (submitted, saved, booked …)
  // (only successful ones: a rejected form is not a completed action)
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return shareWrite(req, res, project, share, m, visitorId);
  const st = status(project.id).status;
  if (st !== 'running') {
    if (st !== 'starting') start(project.id).catch(() => {});
    return res.status(503).send(waitingPage(project, st === 'crashed' ? '暂时无法打开，正在重试…' : '正在启动，请稍候…', true));
  }
  // anonymous visitor id (cookie scoped to this link) for unique-visitor stats
  const cookieName = 'sdv';
  const existing = /(?:^|;\s*)sdv=([A-Za-z0-9_-]{8,32})/.exec(req.headers.cookie || '')?.[1];
  const visitor = existing || crypto.randomBytes(9).toString('base64url');
  forward(req, res, project, m[2], {
    prefix: `/s/${m[1]}`,
    inject: visitorInjection(share, m[1]),
    onPage: () => {
      if (self) return;
      recordView(share.token, visitor, m[2].split('?')[0]);
      if (!existing) res.appendHeader('set-cookie', `${cookieName}=${visitor}; Path=/s/${m[1]}/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    },
  });
}

/** Scripts for share-link visitors: feedback button, (optional) demo tour card, time-on-page beacon. */
function visitorInjection(share, token) {
  const tour = getTour(share.projectId);
  const withTour = tour?.enabled && tour.steps.length;
  return html => {
    let out = share.feedback !== false ? injectFeedback(html, token, readProject(share.projectId)?.plan?.signals || []) : html;
    if (withTour) out = appendScript(out, tourScript(tour, token));
    return appendScript(out, pingScript(token));
  };
}
const appendScript = (html, js) => { const i = html.search(/<\/body>/i), tag = `<script>${js}</script>`; return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag; };

// Anonymous visitors' writes are buffered and screened before they reach the demo: markup in their input could become
// stored XSS in a demo that renders it with innerHTML, and demo pages share the shell's origin (the owner's preview
// would run it). Demos are prototypes: plain text is all a visitor needs to type.
const MAX_WRITE = 8 * 1024 * 1024;
const MARKUP = /<\s*[a-zA-Z!\/?]|javascript\s*:|vbscript\s*:|data:\s*text\/html|\bon[a-z]{3,}\s*=|\bsrcdoc\s*=/i;
export function hasMarkup(raw, type = '') {
  const strings = [];
  const walk = v => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x); };
  if (/json/i.test(type)) { try { walk(JSON.parse(raw)); } catch { strings.push(raw); } }
  else if (/x-www-form-urlencoded/i.test(type)) { try { for (const [k, v] of new URLSearchParams(raw)) strings.push(k, v); } catch { strings.push(raw); } }
  else if (/multipart\/form-data/i.test(type)) {
    // skip the bytes of real raster images; everything else (fields, svg, html, text files) is screened
    for (const part of raw.split(/\r?\n--[^\r\n]+/)) {
      const [head, ...body] = part.split(/\r?\n\r?\n/);
      if (/filename=/i.test(head) && /content-type:\s*image\/(png|jpe?g|gif|webp|bmp|heic|avif)/i.test(head)) continue;
      strings.push(head, body.join('\n\n'));
    }
  } else strings.push(raw);
  return strings.some(s => MARKUP.test(s));
}

function shareWrite(req, res, project, share, m, visitorId) {
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => { size += c.length; if (size > MAX_WRITE) { tooBig = true; req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return res.status(413).json({ error: '提交的内容太大了' });
    const body = Buffer.concat(chunks), type = req.headers['content-type'] || '';
    const text = /multipart/i.test(type) ? body.toString('latin1') : body.toString('utf8');
    if (hasMarkup(text, type)) return res.status(400).json({ error: '内容里不能包含网页代码（如 <标签>、javascript:），请换个写法' });
    // a visitor who sends a write request has actually used the demo (submitted, saved, booked …); only successful
    // ones count, and what they typed is evidence too (real business data vs "test 123")
    if (visitorId) res.on('finish', () => { if (res.statusCode < 400) recordEvent(share.token, visitorId, 'a', { a: `${req.method} ${m[2].split('?')[0].slice(0, 100)}`, b: /multipart/i.test(type) ? '（上传了文件）' : inputSnippet(body.toString('utf8', 0, 2048)) }); });
    forward(req, res, project, m[2], { prefix: `/s/${m[1]}`, inject: false, body });
  });
  req.on('error', () => { if (!res.headersSent) res.status(400).end(); });
}

/** Readable gist of a visitor's form submission: "名称=青菜 进价=1.2"; long digit runs (phone numbers) masked. */
export function inputSnippet(raw) {
  let j; try { j = JSON.parse(raw); } catch { try { j = Object.fromEntries(new URLSearchParams(raw)); } catch { return ''; } }
  const parts = [];
  const walk = (v, k) => {
    if (parts.length >= 12) return;
    if (v && typeof v === 'object') { for (const [kk, vv] of Object.entries(v).slice(0, 12)) walk(vv, kk); return; }
    const t = String(v ?? '').trim();
    if (t && !/^data:/.test(t) && t.length < 300) parts.push(`${k}=${t.slice(0, 60)}`);
  };
  walk(j, '');
  return parts.join(' ').replace(/\d[\d -]{5,}\d/g, m => { const d = m.replace(/\D/g, ''); return d.length >= 7 ? d.slice(0, 3) + '****' + d.slice(-2) : m; }).slice(0, 300);
}

// time on page: POST /s/<token>/__sd/ping { ms, page } (sendBeacon when the page is hidden); visitors with a cookie only
function handlePing(req, res, share, visitor) {
  if (req.method !== 'POST' || !visitor) return res.status(204).end();
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
  req.on('end', () => {
    try { const j = JSON.parse(body); const ms = Math.round(Number(j.ms)); if (ms > 0) recordEvent(share.token, visitor, 'd', { ms: Math.min(ms, 1_800_000), p: String(j.page || '').slice(0, 120) }); } catch {}
    res.status(204).end();
  });
}
const pingScript = token => `(function(){var vis=0,since=document.visibilityState==='visible'?Date.now():0;
function flush(){if(since){vis+=Date.now()-since;since=0;}if(vis<1000)return;var b=JSON.stringify({ms:vis,page:location.pathname.replace(/^\\/s\\/[^/]+/,'')});vis=0;try{navigator.sendBeacon('/s/${token}/__sd/ping',new Blob([b],{type:'application/json'}));}catch(e){}}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')since=Date.now();else flush();});addEventListener('pagehide',flush);})();`;

// visitor feedback: POST /s/<token>/__sd/feedback { text, name, page, viewport }; at most 30 per link per hour
const feedbackRate = new Map();
function handleFeedback(req, res, share) {
  if (req.method !== 'POST') return res.status(405).end();
  // counted before the work (concurrent requests can't slip past): 60 per link per hour, 5 per visitor per hour
  const hour = Math.floor(Date.now() / 3_600_000), key = share.token + ':' + hour;
  const who = key + ':' + (/(?:^|;\s*)sdv=([A-Za-z0-9_-]{8,32})/.exec(req.headers.cookie || '')?.[1] || req.socket.remoteAddress || '');
  const nLink = (feedbackRate.get(key) || 0) + 1, nWho = (feedbackRate.get(who) || 0) + 1;
  feedbackRate.set(key, nLink); feedbackRate.set(who, nWho);
  if (feedbackRate.size > 5000) feedbackRate.clear();
  if (nLink > 60 || nWho > 5) return res.status(429).json({ error: '提交太频繁，请稍后再试' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20_000) req.destroy(); });
  req.on('end', () => {
    try {
      const b = JSON.parse(body || '{}');
      const f = addFeedback(share.projectId, { ...b, share, questions: readProject(share.projectId)?.plan?.signals || [] });
      try { notifyFeedback(readProject(share.projectId), f); } catch {}
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message || '提交失败' }); }
  });
}

/** inject: true -> agent error reporter; a function html => html -> custom injection; false -> untouched. */
function forward(req, res, project, rest, { prefix, inject, onPage, body }) {
  const st = status(project.id).status;
  if (st !== 'running' && st !== 'starting') {
    return res.status(503).send(waitingPage(project, st));
  }
  const headers = { ...req.headers, host: `127.0.0.1:${project.port}`, 'x-forwarded-prefix': prefix };
  if (body) { headers['content-length'] = String(body.length); delete headers['transfer-encoding']; }
  delete headers['accept-encoding']; // keep HTML uncompressed so scripts can be injected
  delete headers.authorization;      // the shell's credentials are not the project's business
  const upstream = http.request({ host: '127.0.0.1', port: project.port, method: req.method, path: rest, headers }, up => {
    const isHtml = /text\/html/i.test(up.headers['content-type'] || '') && req.method === 'GET';
    const page = isHtml && up.statusCode < 400;
    if (!isHtml || !inject || up.headers['content-encoding']) {
      res.status(up.statusCode);
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined) res.setHeader(k, v);
      if (page) onPage?.();
      return up.pipe(res);
    }
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const html = typeof inject === 'function' ? inject(raw) : injectReporter(raw, project.id);
      res.status(up.statusCode);
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && k !== 'content-length') res.setHeader(k, v);
      res.setHeader('content-length', Buffer.byteLength(html));
      if (page) onPage?.();
      res.end(html);
    });
    up.on('error', () => res.end());
  });
  upstream.on('error', err => {
    if (!res.headersSent) res.status(502).send(waitingPage(project, 'unreachable: ' + err.message));
    else res.end();
  });
  if (body) upstream.end(body); else req.pipe(upstream);
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
// Also counts in-flight fetch / XHR (window.__sdInflight) so the agent's page tools can wait for the page to settle.
function errorReporter(id) {
  return `(function(){var u='/api/projects/${id}/client-errors',n=0;
function s(k,m){if(n++>30)return;try{var b=JSON.stringify({kind:k,message:String(m).slice(0,1500),page:location.pathname.replace(/^\\/p\\/[^/]+/,'')});
if(navigator.sendBeacon)navigator.sendBeacon(u,new Blob([b],{type:'application/json'}));else fetch(u,{method:'POST',body:b,headers:{'content-type':'application/json'},keepalive:true});}catch(_){}}
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s('resource','资源加载失败: '+(t.src||t.href).replace(location.origin,''));return;}
s('error',(e.message||'Error')+(e.filename?' @ '+e.filename.replace(location.origin,'')+':'+e.lineno+':'+e.colno:'')+(e.error&&e.error.stack?'\\n'+String(e.error.stack).split('\\n').slice(1,4).join('\\n'):''));},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;s('promise',(r&&(r.stack||r.message))||String(r));});
var ce=console.error;console.error=function(){try{s('console',[].map.call(arguments,function(a){return a&&a.stack?a.stack:typeof a==='object'?JSON.stringify(a):String(a);}).join(' '));}catch(_){}return ce.apply(console,arguments);};
window.__sdInflight=0;function dn(){window.__sdInflight=Math.max(0,window.__sdInflight-1);}
var f=window.fetch;if(f)window.fetch=function(){var a=arguments;window.__sdInflight++;return f.apply(this,a).then(function(r){dn();if(r.status>=500)s('http','请求失败 '+r.status+' '+(a[0]&&a[0].url||a[0]));return r;},function(e){dn();throw e;});};
var xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){window.__sdInflight++;this.addEventListener('loadend',dn);return xs.apply(this,arguments);};})();`;
}

/** visitor: share-link wording (no internal status words). */
/** Floating "提意见" button for share-link visitors (shadow DOM so the demo's CSS can't break it, and vice versa). */
export function injectFeedback(html, token, questions = []) {
  const tag = `<script>${feedbackScript(token, questions)}</script>`;
  const i = html.search(/<\/body>/i);
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}

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
