import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, getSettings, saveSettings, getProjectLlm, maskKey, PRESETS } from './config.js';
import { PROJECT_TYPES, listProjects, createProject, deleteProject, readProject, writeProject, fileTree, safePath } from './registry.js';
import * as runner from './runner.js';
import { proxyMiddleware } from './proxy.js';
import { testConnection } from './llm.js';
import { runAgent, isBusy, usageSummary, generateProjectName } from './agent.js';
import { listSessions, createSession, renameSession, deleteSession, setCurrentSession, loadHistory, clearHistory } from './sessions.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use('/p', proxyMiddleware);
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'shell', 'ui')));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

// ---- settings ----
const publicSettings = s => ({
  ...s,
  apiKey: maskKey(s.apiKey), hasKey: !!s.apiKey,
  projectLlm: { ...s.projectLlm, apiKey: maskKey(s.projectLlm.apiKey), hasKey: !!s.projectLlm.apiKey },
  effectiveProjectLlm: (() => { const e = getProjectLlm(s); return { ...e, apiKey: maskKey(e.apiKey), hasKey: !!e.apiKey }; })(),
});
app.get('/api/settings', (req, res) => res.json({ ...publicSettings(getSettings()), presets: PRESETS }));
app.put('/api/settings', wrap(async (req, res) => {
  const { baseUrl, apiKey, model, temperature, maxIterations, projectLlm } = req.body || {};
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
app.get('/api/projects', (req, res) => res.json(listProjects().map(withStatus)));
app.post('/api/projects/name', wrap(async (req, res) => {
  const description = String(req.body?.description || '').trim();
  if (!description) return res.status(400).json({ error: '请先填写「你想做什么」' });
  res.json({ name: await generateProjectName(description) });
}));
app.post('/api/projects', wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  body.description = String(body.description || '').trim();
  if (!body.description) return res.status(400).json({ error: '请填写「你想做什么」' });
  body.name = String(body.name || '').trim() || await generateProjectName(body.description);
  const p = createProject(body);
  await runner.start(p.id);
  res.json(withStatus(p));
}));
app.get('/api/projects/:id', wrap((req, res) => {
  const p = readProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(withStatus(p));
}));
app.delete('/api/projects/:id', wrap(async (req, res) => {
  await runner.stop(req.params.id);
  deleteProject(req.params.id);
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

// ---- chat ----
const sid = req => (req.query.session || req.body?.session || undefined);
app.get('/api/projects/:id/history', wrap((req, res) => res.json(loadHistory(req.params.id, sid(req)))));
app.get('/api/projects/:id/usage', wrap((req, res) => res.json(usageSummary(req.params.id, sid(req)))));
app.delete('/api/projects/:id/history', wrap((req, res) => { clearHistory(req.params.id, sid(req)); res.json({ ok: true }); }));

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

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    await runAgent(id, message, send, sid(req));
  } catch (e) {
    send({ type: 'error', message: e.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
}));

// ---- boot ----
async function boot() {
  const projects = listProjects();
  for (const p of projects) if (p.autoStart !== false) runner.start(p.id).catch(e => console.error(`[boot] ${p.id}:`, e.message));
  app.listen(PORT, () => {
    const s = getSettings();
    console.log(`\n  SuperDemo 壳已启动:  http://localhost:${PORT}`);
    console.log(`  LLM: ${s.baseUrl || '(未配置)'}  model=${s.model || '(未配置)'}  key=${s.apiKey ? maskKey(s.apiKey) : '(未配置)'}`);
    console.log(`  项目: ${projects.length} 个\n`);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await runner.stopAll(); process.exit(0); });
boot();
