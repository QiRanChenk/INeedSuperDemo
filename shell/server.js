import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, getSettings, saveSettings, getProjectLlm, maskKey, PRESETS } from './config.js';
import { PROJECT_TYPES, SKELETONS, skeletonAvailable, listProjects, createProject, duplicateProject, deleteProject, readProject, writeProject, fileTree, safePath } from './registry.js';
import { listFeedback, countNew, updateFeedback, deleteFeedback, feedbackToMessage } from './feedback.js';
import { demoDataInfo, saveDemoData, restoreDemoData, setDailyReset, runDailyResets } from './demodata.js';
import { getTour, saveTour, generateTour } from './tour.js';
import { getReport, makeReport, evidence, VERDICTS } from './report.js';
import { makePlan, normalizePlan, planToMessage } from './planner.js';
import * as runner from './runner.js';
import { proxyMiddleware, proxyUpgrade, shareMiddleware, upgradeTarget } from './proxy.js';
import { listShares, createShare, revokeShare, deleteSharesOf, setShareOptions, shareStats } from './shares.js';
import { testConnection } from './llm.js';
import { runAgent, attachRun, stopRun, interject, listQueue, enqueue, dequeue, clearQueue, isBusy, usageSummary, generateProjectName, getContextInfo, claimBrowser, resolveBrowser, shotPath } from './agent.js';
import { summary as usageLogSummary, readLog, backfillIfNeeded } from './usagelog.js';
import { listSessions, createSession, renameSession, deleteSession, setCurrentSession, loadHistory, clearHistory, lastChatAt, appendHistory } from './sessions.js';
import { zipProject, dockerInfo, imageInfo, buildImage, isBuilding, saveImage, runHints } from './export.js';
import zlib from 'node:zlib';
import { authMiddleware, checkRequest, startupProblem, HOST, isLoopbackHost, passwordEnabled } from './auth.js';
import { listSnapshots, restoreSnapshot } from './snapshots.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use('/s', shareMiddleware); // share links: public by design, before access control
app.use(authMiddleware);
app.use('/p', proxyMiddleware);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'shell', 'ui')));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- settings ----
const publicSettings = s => ({
  ...s,
  apiKey: maskKey(s.apiKey), hasKey: !!s.apiKey,
  projectLlm: { ...s.projectLlm, apiKey: maskKey(s.projectLlm.apiKey), hasKey: !!s.projectLlm.apiKey },
  effectiveProjectLlm: (() => { const e = getProjectLlm(s); return { ...e, apiKey: maskKey(e.apiKey), hasKey: !!e.apiKey }; })(),
});
app.get('/api/settings', (req, res) => res.json({ ...publicSettings(getSettings()), presets: PRESETS }));
app.put('/api/settings', wrap(async (req, res) => {
  const { baseUrl, apiKey, model, temperature, maxIterations, contextWindow, stream, projectLlm, vision } = req.body || {};
  const before = JSON.stringify(getProjectLlm());
  const patch = {};
  if (projectLlm && typeof projectLlm === 'object') {
    patch.projectLlm = {};
    if (projectLlm.useShell !== undefined) patch.projectLlm.useShell = !!projectLlm.useShell;
    if (projectLlm.baseUrl !== undefined) patch.projectLlm.baseUrl = String(projectLlm.baseUrl).trim();
    if (projectLlm.model !== undefined) patch.projectLlm.model = String(projectLlm.model).trim();
    if (projectLlm.apiKey !== undefined && !String(projectLlm.apiKey).includes('****')) patch.projectLlm.apiKey = String(projectLlm.apiKey).trim();
  }
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).trim();
  if (model !== undefined) patch.model = String(model).trim();
  if (apiKey !== undefined && !String(apiKey).includes('****')) patch.apiKey = String(apiKey).trim();
  const t = Number(temperature), it = parseInt(maxIterations, 10);
  if (temperature !== undefined && temperature !== '' && Number.isFinite(t) && t >= 0 && t <= 2) patch.temperature = t;
  if (maxIterations !== undefined && Number.isInteger(it) && it >= 1 && it <= 200) patch.maxIterations = it;
  const cw = parseInt(contextWindow, 10);
  if (contextWindow !== undefined && Number.isInteger(cw) && cw >= 1000 && cw <= 100_000_000) patch.contextWindow = cw;
  if (stream !== undefined) patch.stream = !!stream;
  if (['auto', 'on', 'off'].includes(vision)) patch.vision = vision;
  // model / endpoint / vision mode changed -> image support has to be detected again
  const cur = getSettings();
  if ((patch.vision && patch.vision !== cur.vision) || (patch.model && patch.model !== cur.model) || (patch.baseUrl && patch.baseUrl !== cur.baseUrl)) { patch.visionOk = null; patch.visionError = ''; }
  const s = saveSettings(patch);
  // project-side LLM changed -> restart running projects so the new env takes effect
  let restarted = [];
  if (JSON.stringify(getProjectLlm(s)) !== before) {
    restarted = runner.runningIds();
    await Promise.all(restarted.map(id => runner.restart(id).catch(() => {})));
  }
  res.json({ ...publicSettings(s), restarted });
}));
app.post('/api/settings/test', wrap(async (req, res) => res.json(await testConnection())));
app.post('/api/settings/test-project', wrap(async (req, res) => {
  const e = getProjectLlm();
  res.json({ ...(await testConnection({ ...getSettings(), ...e })), source: e.source, model: e.model });
}));

// ---- projects ----
const withStatus = p => ({ ...p, ...runner.status(p.id), busy: isBusy(p.id), typeLabel: PROJECT_TYPES[p.type]?.label, hasUi: !!PROJECT_TYPES[p.type]?.hasUi });

app.get('/api/project-types', (req, res) => res.json(Object.entries(PROJECT_TYPES).map(([id, t]) => ({ id, label: t.label, available: !!t.template }))));
// most recently chatted first; never-chatted projects fall back to creation time
app.get('/api/projects', (req, res) => res.json(listProjects()
  .map(p => ({ ...withStatus(p), lastChatAt: lastChatAt(p.id), feedbackNew: countNew(p.id), validation: validationOf(p) }))
  .sort((a, b) => String(b.lastChatAt || b.createdAt).localeCompare(String(a.lastChatAt || a.createdAt)))));
app.get('/api/skeletons', (req, res) => res.json(Object.entries(SKELETONS).map(([id, k]) => ({ id, label: k.label, fit: k.fit, available: skeletonAvailable(id) }))));
// plan first: one-line request -> editable plan (nothing is created yet)
app.post('/api/projects/plan', wrap(async (req, res) => {
  const description = String(req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: '请先填写「你想做什么」' });
  const plan = await makePlan(description);
  if (!skeletonAvailable(plan.skeleton)) plan.skeleton = 'blank';
  res.json({ plan });
}));
app.post('/api/projects/name', wrap(async (req, res) => {
  const description = String(req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: '请先填写「你想做什么」' });
  res.json({ name: await generateProjectName(description) });
}));
app.post('/api/projects', wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  body.description = String(body.description || '').trim();
  if (!body.description) return res.status(400).json({ error: '请填写「你想做什么」' });
  // with a confirmed plan: its skeleton is used and the plan becomes the first instruction (returned as firstMessage)
  const plan = body.plan ? normalizePlan(body.plan) : null;
  body.name = String(body.name || plan?.name || '').trim() || await generateProjectName(body.description);
  const p = await createProject({ name: body.name, description: body.description, type: body.type, skeleton: plan?.skeleton || body.skeleton, plan: plan || undefined });
  await runner.start(p.id);
  res.json({ ...withStatus(p), firstMessage: plan ? planToMessage(plan, body.description) : `请根据以下需求改造这个项目：\n${body.description}` });
}));
app.get('/api/projects/:id', wrap((req, res) => {
  const p = readProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(withStatus(p));
}));
app.delete('/api/projects/:id', wrap(async (req, res) => {
  await runner.stop(req.params.id);
  deleteProject(req.params.id);
  deleteSharesOf(req.params.id);
  res.json({ ok: true });
}));
const setAutoStart = (id, on) => { const p = readProject(id); if (p && p.autoStart !== on) writeProject({ ...p, autoStart: on }); };
app.post('/api/projects/:id/start', wrap(async (req, res) => { setAutoStart(req.params.id, true); res.json(await runner.start(req.params.id)); }));
app.post('/api/projects/:id/stop', wrap(async (req, res) => { setAutoStart(req.params.id, false); res.json(await runner.stop(req.params.id)); }));
app.post('/api/projects/:id/restart', wrap(async (req, res) => res.json(await runner.restart(req.params.id))));
app.get('/api/projects/:id/logs', wrap((req, res) => res.json(runner.logs(req.params.id))));
app.get('/api/projects/:id/files', wrap((req, res) => res.json(fileTree(req.params.id))));
app.get('/api/projects/:id/file', wrap((req, res) => {
  const abs = safePath(req.params.id, String(req.query.path || ''));
  res.type('text/plain').send(fs.readFileSync(abs, 'utf8'));
}));

// ---- front-end errors reported by the preview page (script injected by the proxy) ----
const recentWebErrors = new Map(); // `${id}\n${message}` -> ts, to drop repeats
app.post('/api/projects/:id/client-errors', (req, res) => {
  const id = req.params.id, b = req.body || {};
  res.status(204).end();
  if (!readProject(id)) return;
  const msg = `[${String(b.kind || 'error').slice(0, 20)}] ${String(b.message || '').slice(0, 1500).replace(/\s*\n\s*/g, ' ⏎ ')}${b.page && b.page !== '/' ? ` (页面 ${String(b.page).slice(0, 200)})` : ''}`;
  const key = id + '\n' + msg, now = Date.now();
  if (now - (recentWebErrors.get(key) || 0) < 10_000) return;
  recentWebErrors.set(key, now);
  if (recentWebErrors.size > 500) for (const [k, t] of recentWebErrors) if (now - t > 60_000) recentWebErrors.delete(k);
  runner.log(id, 'web', msg);
});

// ---- agent page tools: an open tab claims the request, works on the preview and posts the result ----
app.post('/api/projects/:id/browser/:reqId/claim', (req, res) => res.json({ ok: claimBrowser(req.params.id, req.params.reqId) }));
app.post('/api/projects/:id/browser/:reqId/result', (req, res) => res.json({ ok: resolveBrowser(req.params.id, req.params.reqId, req.body || {}) }));
app.get('/api/projects/:id/shots/:file', wrap((req, res) => {
  const f = shotPath(req.params.id, req.params.file);
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.type('image/jpeg').sendFile(f);
}));

// ---- duplicate (variant) ----
app.post('/api/projects/:id/duplicate', wrap(async (req, res) => {
  const p = await duplicateProject(req.params.id, req.body?.name);
  await runner.start(p.id);
  res.json(withStatus(p));
}));

// ---- visitor feedback ----
app.get('/api/projects/:id/feedback', wrap((req, res) => res.json(listFeedback(req.params.id))));
app.patch('/api/projects/:id/feedback', wrap((req, res) => res.json(updateFeedback(req.params.id, req.body?.ids || [], req.body?.status))));
app.delete('/api/projects/:id/feedback', wrap((req, res) => res.json(deleteFeedback(req.params.id, req.body?.ids || []))));
// selected feedback -> agent instruction (the client sends it like a normal message, then marks the items as sent)
app.post('/api/projects/:id/feedback/message', wrap((req, res) => {
  const set = new Set(req.body?.ids || []);
  const items = listFeedback(req.params.id).filter(f => set.has(f.id)).reverse();
  if (!items.length) return res.status(400).json({ error: '请先选择反馈' });
  res.json({ message: feedbackToMessage(items) });
}));

// ---- idea validation: stage + signals for the idea board, and the AI verdict report ----
function validationOf(p) {
  const fb = listFeedback(p.id), reactions = { up: 0, meh: 0, down: 0 };
  for (const f of fb) if (f.reaction) reactions[f.reaction]++;
  const report = getReport(p.id), shares = listShares(p.id).filter(s => s.active).length, chatted = !!lastChatAt(p.id);
  const stage = isBusy(p.id) || !chatted ? 'building' : report ? 'concluded' : shares ? 'validating' : 'ready';
  let thumb = null;
  try { thumb = fs.readdirSync(path.join(ROOT, 'projects', p.id, '.superdemo', 'shots')).filter(f => f.endsWith('.jpg') && !f.endsWith('-m.jpg')).sort().pop() || null; } catch {} // desktop shots only
  return { stage, hypothesis: p.plan?.hypothesis || '', reactions, feedback: fb.length, shares, verdict: report?.verdict || null, verdictLabel: report ? VERDICTS[report.verdict] : null, thumb };
}
app.get('/api/projects/:id/report', wrap((req, res) => res.json({ report: getReport(req.params.id), evidence: evidence(req.params.id) })));
app.post('/api/projects/:id/report', wrap(async (req, res) => res.json({ report: await makeReport(req.params.id), evidence: evidence(req.params.id) })));

// ---- visitor tour (shown on share links) ----
app.get('/api/projects/:id/tour', wrap((req, res) => res.json(getTour(req.params.id) || { enabled: false, title: '', intro: '', steps: [] })));
app.put('/api/projects/:id/tour', wrap((req, res) => res.json(saveTour(req.params.id, req.body || {}))));
app.post('/api/projects/:id/tour/generate', wrap(async (req, res) => res.json(await generateTour(req.params.id))));

// ---- demo data snapshot ----
app.get('/api/projects/:id/demo-data', wrap((req, res) => res.json(demoDataInfo(req.params.id))));
app.post('/api/projects/:id/demo-data/save', wrap(async (req, res) => {
  if (isBusy(req.params.id)) return res.status(409).json({ error: 'AI 正在处理，请稍后再保存' });
  res.json(await saveDemoData(req.params.id));
}));
app.post('/api/projects/:id/demo-data/restore', wrap(async (req, res) => {
  if (isBusy(req.params.id)) return res.status(409).json({ error: 'AI 正在处理，请稍后再恢复' });
  res.json(await restoreDemoData(req.params.id));
}));
app.put('/api/projects/:id/demo-data', wrap((req, res) => res.json(setDailyReset(req.params.id, !!req.body?.daily))));

// ---- share links ----
app.get('/api/projects/:id/shares', wrap((req, res) => res.json(listShares(req.params.id))));
app.post('/api/projects/:id/shares', wrap(async (req, res) => {
  const id = req.params.id;
  if (!readProject(id)) return res.status(404).json({ error: 'not found' });
  const share = createShare(id, req.body || {});
  setAutoStart(id, true); // a shared demo should stay reachable, also after the shell restarts
  await runner.start(id);
  res.json(share);
}));
app.delete('/api/projects/:id/shares/:token', wrap((req, res) => res.json(revokeShare(req.params.id, req.params.token))));
app.patch('/api/projects/:id/shares/:token', wrap((req, res) => res.json(setShareOptions(req.params.id, req.params.token, req.body || {}))));
app.get('/api/projects/:id/shares/:token/stats', wrap((req, res) => res.json(shareStats(req.params.token))));

// ---- versions (per-turn code snapshots) ----
app.get('/api/projects/:id/snapshots', wrap((req, res) => res.json(listSnapshots(req.params.id))));
app.post('/api/projects/:id/snapshots/:sid/restore', wrap(async (req, res) => {
  const id = req.params.id;
  if (isBusy(id)) return res.status(409).json({ error: 'AI 正在处理，请先停止或等待完成' });
  const r = restoreSnapshot(id, req.params.sid);
  const when = new Date(r.restored.ts).toLocaleString('zh-CN', { hour12: false });
  appendHistory(id, undefined, { role: 'user', system: true, ts: Date.now(),
    content: `[系统] 用户已把项目代码回滚到「${r.restored.label || when}」这一轮开始前的版本（${when}）；业务数据未变。此前读到的文件内容可能已过期，修改前请重新读取。` });
  const st = await runner.restart(id);
  res.json({ ...r, status: st.status });
}));

// ---- export / deploy ----
app.get('/api/projects/:id/export', wrap((req, res) => {
  const { name, buffer } = zipProject(req.params.id);
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${req.params.id}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buffer);
}));
app.get('/api/projects/:id/image', wrap(async (req, res) => {
  const p = readProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const docker = await dockerInfo();
  const image = docker.available ? await imageInfo(req.params.id) : null;
  res.json({ docker, image, building: isBuilding(req.params.id), hints: runHints(req.params.id, p) });
}));
// build the image, streaming docker output as SSE lines
app.post('/api/projects/:id/image', wrap(async (req, res) => {
  const id = req.params.id, p = readProject(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (isBuilding(id)) return res.status(409).json({ error: '该项目正在构建镜像' });
  const docker = await dockerInfo();
  if (!docker.available) return res.status(400).json({ error: docker.reason });
  const { send, end } = sse(res);
  try {
    const r = await buildImage(id, l => send({ type: 'line', ...l }));
    send({ type: 'done', ...r, image: r.ok ? await imageInfo(id) : null, hints: runHints(id, p) });
  } catch (e) { send({ type: 'error', message: e.message }); }
  finally { end(); }
}));
// docker save | gzip -> download
app.get('/api/projects/:id/image.tar.gz', wrap(async (req, res) => {
  const id = req.params.id;
  if (!(await imageInfo(id))) return res.status(404).json({ error: '尚未构建镜像' });
  res.setHeader('content-type', 'application/gzip');
  res.setHeader('content-disposition', `attachment; filename="superdemo-${id}.tar.gz"`);
  const proc = saveImage(id);
  let err = '';
  proc.stderr.on('data', d => { err += d; });
  proc.on('exit', code => { if (code !== 0) { console.error('[export] docker save failed:', err.trim()); res.destroy(); } });
  req.on('close', () => { try { proc.kill(); } catch {} });
  proc.stdout.pipe(zlib.createGzip({ level: 1 })).pipe(res);
}));

// ---- chat ----
const sid = req => (req.query.session || req.body?.session || undefined);
app.get('/api/projects/:id/history', wrap((req, res) => res.json(loadHistory(req.params.id, sid(req)))));
app.get('/api/projects/:id/usage', wrap((req, res) => res.json(usageSummary(req.params.id, sid(req)))));
app.get('/api/projects/:id/context', wrap((req, res) => res.json(getContextInfo(req.params.id, sid(req)))));
app.delete('/api/projects/:id/history', wrap((req, res) => { clearHistory(req.params.id, sid(req)); res.json({ ok: true }); }));

// ---- shell-wide token usage log ----
app.get('/api/usage/summary', wrap((req, res) => res.json(usageLogSummary())));
app.get('/api/usage/log', wrap((req, res) => {
  const from = Number(req.query.from) || 0, to = Number(req.query.to) || Date.now();
  const names = Object.fromEntries(listProjects().map(p => [p.id, p.name]));
  names._naming = '项目起名';
  res.json({ from, to, entries: readLog(from, to), names });
}));

// ---- sessions ----
app.get('/api/projects/:id/sessions', wrap((req, res) => res.json(listSessions(req.params.id))));
app.post('/api/projects/:id/sessions', wrap((req, res) => res.json(createSession(req.params.id, req.body?.title))));
app.patch('/api/projects/:id/sessions/:sid', wrap((req, res) => res.json(renameSession(req.params.id, req.params.sid, req.body?.title))));
app.delete('/api/projects/:id/sessions/:sid', wrap((req, res) => res.json({ current: deleteSession(req.params.id, req.params.sid) })));
app.post('/api/projects/:id/sessions/:sid/activate', wrap((req, res) => res.json({ current: setCurrentSession(req.params.id, req.params.sid) })));

app.post('/api/projects/:id/chat', wrap(async (req, res) => {
  const id = req.params.id;
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (isBusy(id)) return res.status(409).json({ error: '该项目正在处理上一条消息' });

  const { send, end } = sse(res);
  const budget = Number(req.body?.budget) > 0 ? Math.min(200, Number(req.body.budget)) : 0;
  try { await runAgent(id, message, send, sid(req), { budget }); }
  catch (e) { if (!e.emitted) send({ type: 'error', message: e.message }); } // run errors are already emitted as events by runAgent
  finally { end(); }
}));

// Stop the in-flight run of a project (any tab may call this; all attached tabs see the resulting 'done' event).
app.post('/api/projects/:id/chat/stop', wrap((req, res) => res.json({ stopped: stopRun(req.params.id) })));

// Mid-run message: queued for the running turn. queued=false means the run already ended -> client sends it as a normal message.
app.post('/api/projects/:id/chat/say', wrap((req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  res.json({ queued: interject(req.params.id, message) });
}));

// Held-back messages: sent together as the next turn once the current run ends. queued=false -> project idle, send normally.
app.get('/api/projects/:id/chat/queue', wrap((req, res) => res.json({ items: listQueue(req.params.id) })));
app.post('/api/projects/:id/chat/queue', wrap((req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const items = enqueue(req.params.id, message, sid(req));
  res.json({ queued: !!items, items: items || [] });
}));
app.delete('/api/projects/:id/chat/queue', wrap((req, res) => res.json({ items: clearQueue(req.params.id) })));
app.delete('/api/projects/:id/chat/queue/:qid', wrap((req, res) => res.json({ items: dequeue(req.params.id, req.params.qid) })));

// Re-attach to an in-flight run (page reload / second tab): replays live state, then streams until done.
app.get('/api/projects/:id/chat/attach', (req, res) => {
  const { send, end } = sse(res);
  // end on the next tick so a trailing 'next' event (queued messages started another turn) still gets through
  const off = attachRun(req.params.id, ev => { send(ev); if (ev.type === 'done' || ev.type === 'error') setImmediate(end); });
  if (!off) { send({ type: 'idle' }); return end(); }
  req.on('close', off);
});

function sse(res) {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, 15000);
  return {
    send: ev => { if (open) res.write(`data: ${JSON.stringify(ev)}\n\n`); },
    end: () => { clearInterval(ping); if (open) { open = false; res.end(); } },
  };
}

// ---- boot ----
async function boot() {
  const problem = startupProblem();
  if (problem) { console.error('\n  ✗ ' + problem.replace(/\n/g, '\n    ') + '\n'); process.exit(1); }
  const n = backfillIfNeeded(); if (n) console.log(`[boot] token usage log backfilled: ${n} entries`);
  const projects = listProjects();
  for (const p of projects) if (p.autoStart !== false) runner.start(p.id).catch(e => console.error(`[boot] ${p.id}:`, e.message));
  // daily demo-data reset (checked every 10 minutes; runs once a day after 04:00 local time)
  setInterval(() => runDailyResets(listProjects(), isBusy).catch(e => console.error('[demo-data]', e.message)), 10 * 60_000).unref();
  const server = app.listen(PORT, HOST, () => {
    const s = getSettings();
    console.log(`\n  SuperDemo 壳已启动:  http://${isLoopbackHost(HOST) ? 'localhost' : HOST}:${PORT}${passwordEnabled() ? '  (已启用访问口令)' : ''}`);
    console.log(`  LLM: ${s.baseUrl || '(未配置)'}  model=${s.model || '(未配置)'}  key=${s.apiKey ? maskKey(s.apiKey) : '(未配置)'}`);
    console.log(`  项目: ${projects.length} 个\n`);
  });
  // WebSocket upgrades: /p/<id>/… behind the shell's access control, /s/<token>/… via a live share link
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/s/')) { const t = upgradeTarget(req.url); return t ? proxyUpgrade(req, socket, head, t) : socket.destroy(); }
    const bad = checkRequest(req);
    if (bad) return socket.end(`HTTP/1.1 ${bad.status} ${bad.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`);
    if (req.url.startsWith('/p/')) return proxyUpgrade(req, socket, head);
    socket.destroy();
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await runner.stopAll(); process.exit(0); });
boot();
