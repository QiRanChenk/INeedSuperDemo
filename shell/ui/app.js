const $ = s => document.querySelector(s);
let projects = [], current = null, settings = null;
let currentSession = null;   // active session id of the current project
let sessions = [];
const viewKey = () => current ? `${current.id}:${currentSession}` : '';
const sameProject = key => !!current && String(key).split(':')[0] === current.id;
const streams = new Map();   // projectId -> true while this tab holds an open SSE stream
const wasBusy = new Map();   // projectId -> last known server busy flag

async function api(path, opts = {}) {
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) }; }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const isBusy = p => !!(p && (p.busy || streams.has(p.id)));

// ---------- projects ----------
async function loadProjects() {
  projects = await api('/api/projects');
  const ul = $('#projectList'); ul.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = p.id === current?.id ? 'active' : '';
    li.innerHTML = `<span class="dot ${p.status}"></span><span class="n">${esc(p.name)}</span>${isBusy(p) ? '<span class="thinking small">⋯</span>' : ''}<span class="muted small">:${p.port}</span>`;
    li.onclick = () => select(p.id);
    ul.appendChild(li);
    // a turn finished on the server that this tab was not streaming (e.g. page reload / other tab): refresh view
    if (wasBusy.get(p.id) && !p.busy && !streams.has(p.id) && current?.id === p.id) { loadHistory(); reloadFrame(); }
    // a turn started elsewhere (other tab): re-render history, which attaches to the live run
    if (p.busy && !wasBusy.get(p.id) && !streams.has(p.id) && current?.id === p.id) loadHistory();
    wasBusy.set(p.id, p.busy);
  }
  if (current) { const fresh = projects.find(p => p.id === current.id); if (fresh) current = fresh; }
  renderHeader();
}

async function select(id) {
  if (current?.id === id) return;
  current = projects.find(p => p.id === id) || null;
  await loadProjects();
  if (!current) return;
  const url = `/p/${current.id}/`;
  const live = current.status === 'running' || current.status === 'starting';
  $('#frame').src = current.hasUi && live ? url : 'about:blank';
  $('#previewUrl').textContent = url;
  $('#btnOpen').href = url;
  await loadSessions();
  await Promise.all([loadHistory(), loadUsage(), loadQueue()]);
}

// ---------- sessions ----------
async function loadSessions(keep = false) {
  if (!current) { $('#sessionBar').hidden = true; return; }
  const pid = current.id;
  const data = await api(`/api/projects/${pid}/sessions`);
  if (current?.id !== pid) return;
  sessions = data.list;
  if (!keep || !sessions.some(s => s.id === currentSession)) currentSession = data.current;
  const sel = $('#sessionSel'); sel.innerHTML = '';
  for (const s of [...sessions].reverse()) {
    const o = document.createElement('option'); o.value = s.id;
    o.textContent = `${s.title}${s.messages ? ` · ${s.messages} 条` : ''}`;
    sel.appendChild(o);
  }
  sel.value = currentSession;
  $('#sessionBar').hidden = false;
}
async function switchSession(sid) {
  if (!current || sid === currentSession) return;
  currentSession = sid;
  await api(`/api/projects/${current.id}/sessions/${sid}/activate`, { method: 'POST' });
  $('#sessionSel').value = sid;
  await Promise.all([loadHistory(), loadUsage()]);
}
$('#sessionSel').onchange = e => switchSession(e.target.value);
$('#btnNewSession').onclick = async () => {
  if (!current) return;
  const s = await api(`/api/projects/${current.id}/sessions`, { method: 'POST', body: {} });
  currentSession = s.id;
  await loadSessions(true);
  await Promise.all([loadHistory(), loadUsage()]);
  $('#input').focus();
};
$('#btnRenameSession').onclick = async () => {
  const s = sessions.find(x => x.id === currentSession); if (!s) return;
  const title = prompt('会话名称', s.title); if (title === null || !title.trim()) return;
  await api(`/api/projects/${current.id}/sessions/${currentSession}`, { method: 'PATCH', body: { title: title.trim() } });
  await loadSessions(true);
};
$('#btnDeleteSession').onclick = async () => {
  const s = sessions.find(x => x.id === currentSession); if (!s) return;
  if (isBusy(current)) return alert('该项目正在处理消息，稍后再删除');
  if (!confirm(`删除会话「${s.title}」及其对话记录？项目代码不受影响。`)) return;
  const r = await api(`/api/projects/${current.id}/sessions/${currentSession}`, { method: 'DELETE' });
  currentSession = r.current;
  await loadSessions(true);
  await Promise.all([loadHistory(), loadUsage()]);
};

// ---------- token usage ----------
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
function usageLine(u) {
  if (!u || !u.calls) return '<span class="muted">暂无</span>';
  const hit = u.input ? Math.round(u.cached / u.input * 100) : 0;
  // speed: latest call first (what the user just experienced); average over all timed calls in the tooltip
  const spd = u.lastSpeed ?? u.avgSpeed;
  const speed = spd ? ` <span class="sep">·</span> <span title="最近一次调用 ${u.lastSpeed ?? '—'} t/s · 平均 ${u.avgSpeed ?? '—'} t/s，按首字后的生成时长计算）">速度 <b>${spd}</b> t/s</span>` : '';
  return `输入 <b>${fmt(u.input)}</b> <span class="sep">·</span> 输出 <b>${fmt(u.output)}</b> <span class="sep">·</span> 缓存命中 <b>${hit}%</b> <span class="sep">·</span> 合计 <b>${fmt(u.total)}</b> <span class="sep">·</span> ${u.calls} 次调用${speed}`;
}
function renderUsage(pid, data) {
  if (viewKey() !== pid) return;
  $('#usage').hidden = false;
  $('#uSession').innerHTML = usageLine(data.session);
  $('#uProject').innerHTML = usageLine(data.project);
}
function renderContext(pid, c) {
  if (viewKey() !== pid) return;
  const el = $('#uContext');
  const win = c.window || settings?.contextWindow || 1e6;
  const pct = Math.min(100, c.tokens / win * 100);
  el.className = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  el.innerHTML = `≈ <b>${fmt(c.tokens)}</b> tokens <span class="ctxbar"><i style="width:${pct.toFixed(1)}%"></i></span><b>${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%</b> / ${fmt(win)} · ${c.messages} 条消息${c.compacted ? ` · 已压缩 ${c.compacted} 条旧记录` : ''}`;
}
async function loadContext() {
  if (!current) return;
  const pid = viewKey();
  try { renderContext(pid, await api(`/api/projects/${current.id}/context?session=${encodeURIComponent(currentSession || '')}`)); } catch {}
}
async function loadUsage() {
  if (!current) { $('#usage').hidden = true; return; }
  const pid = viewKey();
  try { renderUsage(pid, await api(`/api/projects/${current.id}/usage?session=${encodeURIComponent(currentSession || '')}`)); } catch {}
}

function renderHeader() {
  const has = !!current, busy = isBusy(current);
  const live = has && (current.status === 'running' || current.status === 'starting');
  for (const id of ['btnToggle', 'btnLogs', 'btnFiles', 'btnVersions', 'btnExport', 'btnDelete']) $('#' + id).disabled = !has;
  $('#btnRestart').disabled = !live;
  $('#btnToggle').textContent = live ? '■ 停止' : '▶ 启动';
  $('#btnToggle').classList.toggle('start', has && !live);
  document.body.classList.toggle('no-preview', has && !live);
  if (has && !live && $('#frame').src !== 'about:blank') $('#frame').src = 'about:blank';
  if (live && current.hasUi && $('#frame').src === 'about:blank') $('#frame').src = `/p/${current.id}/`;
  $('#btnClear').disabled = !has || busy;
  // busy: empty input -> stop button; typed text -> interject (queued into the running turn)
  const sendBtn = $('#send'), typed = !!$('#input').value.trim(), isStopping = busy && stopping.has(current.id);
  sendBtn.disabled = !has || isStopping;
  sendBtn.textContent = !busy ? '发送' : isStopping ? '停止中…' : typed ? '↩ 插话' : '■ 停止';
  sendBtn.classList.toggle('stop', busy && !typed);
  sendBtn.title = !busy ? '' : typed ? '插话：当前步骤完成后 AI 会看到这条消息 (Enter)' : '停止本轮处理 (Esc)';
  $('#queueBtn').hidden = !(busy && typed && !isStopping);
  $('#pName').textContent = current ? current.name : '选择或新建一个项目';
  $('#pMeta').textContent = current ? `${current.typeLabel} · ${current.status} · 端口 ${current.port} · id ${current.id}` : '';
}

/** Full replay of the persisted history, including the thinking process (tool calls, results, restarts, reasoning). */
async function loadHistory() {
  if (!current) return;
  const pid = viewKey();
  const hist = await api(`/api/projects/${current.id}/history?session=${encodeURIComponent(currentSession || '')}`);
  if (viewKey() !== pid) return; // switched while fetching
  const box = $('#messages'); box.innerHTML = '';
  for (const m of hist) {
    if (m.role === 'user') { m.system ? addSys(pid, firstLine(m.content)) : m.interjection ? addInterjection(pid, m.content) : addMsg(pid, 'user', m.content); continue; }
    if (m.role === 'assistant') {
      if (m.reasoning) addReasoning(pid, m.reasoning);
      if (m.content) addMsg(pid, 'assistant', m.content);
      for (const tc of m.tool_calls || []) addTool(pid, tc.function.name, safeParse(tc.function.arguments));
      continue;
    }
    if (m.role === 'tool') addToolResult(pid, m.name, m.content);
  }
  if (!hist.length) addSys(pid, '新会话。项目代码与其他会话共享，对话记忆从这里重新开始。');
  if (isBusy(current)) { showThinking(pid, '处理中…'); if (!streams.has(current.id)) attach(current.id); }
  loadContext();
  box.scrollTop = box.scrollHeight;
}

// ---------- rendering (all bound to a project id; ignored if the user switched away) ----------
/** Append and auto-scroll: follows new content unless the user has scrolled up to read history. */
function append(pid, el, force = false) {
  if (viewKey() !== pid) return el;
  const box = $('#messages');
  const follow = force || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const t = $('#thinking'); t ? box.insertBefore(el, t) : box.appendChild(el);
  if (follow) box.scrollTop = box.scrollHeight;
  return el;
}
function addMsg(pid, role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; return append(pid, d, role === 'user'); }
function addSys(pid, text) { return addMsg(pid, 'sys', text); }
function addInterjection(pid, text) { const d = addMsg(pid, 'user', text); d.classList.add('interjection'); d.title = '插话（在 AI 处理过程中补充）'; return d; }
function addTool(pid, name, args) {
  const d = document.createElement('div'); d.className = 'tool';
  const a = !args ? '' : name === 'http_request' ? `${args.method || 'GET'} ${args.path || ''}`
    : name === 'grep' ? `/${args.pattern || ''}/ ${args.path || ''}`
    : name === 'read_file' && args.offset ? `${args.path} :${args.offset}${args.limit ? '+' + args.limit : ''}`
    : args.path || args.command || (args.lines ? `${args.lines} lines` : '');
  d.innerHTML = `<b>${esc(name)}</b> ${esc(typeof a === 'string' ? a : JSON.stringify(a))}`;
  return append(pid, d);
}
function addToolResult(pid, name, content) {
  const d = document.createElement('div'); d.className = 'tool result'; d.title = name || '';
  d.textContent = '↳ ' + String(content ?? '').slice(0, 240).replace(/\n+/g, ' ⏎ ');
  return append(pid, d);
}
function addReasoning(pid, text) {
  const d = document.createElement('details'); d.className = 'reasoning';
  d.innerHTML = `<summary>模型思考（${text.length} 字）</summary><pre></pre>`; d.querySelector('pre').textContent = text;
  return append(pid, d);
}
function showThinking(pid, text) {
  if (viewKey() !== pid) return;
  let t = $('#thinking');
  if (!t) { t = document.createElement('div'); t.id = 'thinking'; t.className = 'msg sys thinking'; $('#messages').appendChild(t); }
  t.textContent = text;
  const box = $('#messages'); if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}
function hideThinking(pid) { if (viewKey() === pid) $('#thinking')?.remove(); }

// ---------- streaming bubbles ----------
// One in-progress assistant bubble / reasoning block per view; finalized by the matching 'text' / 'reasoning' / 'done' event.
const live = new Map(); // pid -> { msg, reasoning }
function liveOf(pid) { let l = live.get(pid); if (!l) { l = {}; live.set(pid, l); } return l; }
function onDelta(pid, ev) {
  if (viewKey() !== pid) return;
  const l = liveOf(pid), box = $('#messages');
  const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (ev.reasoning) {
    if (!l.reasoning) { l.reasoning = addReasoning(pid, ''); l.reasoning.classList.add('live'); l.reasoning.open = true; }
    l.reasoning.querySelector('pre').textContent += ev.reasoning;
    l.reasoning.querySelector('summary').textContent = `模型思考中（${l.reasoning.querySelector('pre').textContent.length} 字）`;
  }
  if (ev.content) {
    // first answer token: the thinking phase is over -> settle the reasoning block (collapsed) while the answer streams
    if (l.reasoning?.classList.contains('live')) { const d = l.reasoning; d.classList.remove('live'); d.open = false; d.querySelector('summary').textContent = `模型思考（${d.querySelector('pre').textContent.length} 字）`; }
    if (!l.msg) { l.msg = addMsg(pid, 'assistant', ''); l.msg.classList.add('live'); }
    l.msg.textContent += ev.content;
  }
  if (follow) box.scrollTop = box.scrollHeight;
}
function finishText(pid, content) {
  const l = live.get(pid);
  if (l?.msg) { l.msg.textContent = content; l.msg.classList.remove('live'); l.msg = null; }
  else if (content) addMsg(pid, 'assistant', content);
}
function finishReasoning(pid, content) {
  const l = live.get(pid);
  if (l?.reasoning) { const d = l.reasoning; d.querySelector('pre').textContent = content; d.querySelector('summary').textContent = `模型思考（${content.length} 字）`; d.classList.remove('live'); d.open = false; l.reasoning = null; }
  else addReasoning(pid, content);
}
function dropLive(pid) { const l = live.get(pid); if (l?.msg) l.msg.classList.remove('live'); if (l?.reasoning) l.reasoning.classList.remove('live'); live.delete(pid); }

/** Read an SSE response, dispatching each event. onEvent may return a new pid (used by attach once the run's session is known). */
async function readEvents(res, pid, onEvent) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
      pid = onEvent(pid, JSON.parse(line.slice(6))) ?? pid;
    }
  }
  return pid;
}

/** Page reload / second tab: re-attach to a run that is still going on the server. */
async function attach(projectId) {
  if (streams.has(projectId)) return;
  streams.set(projectId, true); renderHeader();
  let pid = `${projectId}:`;
  try {
    const res = await fetch(`/api/projects/${projectId}/chat/attach`);
    if (!res.ok) throw new Error(res.statusText);
    pid = await readEvents(res, pid, (p, ev) => {
      if (ev.type === 'attached') { renderQueue(projectId, ev.queue || []); return `${projectId}:${ev.session}`; }
      if (ev.type === 'idle') return p;
      handleEvent(p, ev); return p;
    });
  } catch {}
  finally {
    streams.delete(projectId); stopDone(projectId); wasBusy.set(projectId, false); hideThinking(pid); dropLive(pid); renderHeader(); loadProjects();
    if (autoNext.has(projectId)) return followNext(projectId);
    if (current?.id === projectId) { loadHistory(); loadUsage(); loadSessions(true); } // persisted truth, in case anything was missed while attaching
  }
}

// ---------- chat ----------
/** Busy project: queue the text into the running turn. Falls back to a normal send if the run ended meanwhile. */
async function interject(text) {
  if (!current || !text.trim()) return;
  const projectId = current.id, pid = viewKey();
  $('#input').value = ''; renderHeader();
  try {
    const r = await api(`/api/projects/${projectId}/chat/say`, { method: 'POST', body: { message: text } });
    if (!r.queued) { if (!isBusy(current)) return send(text); addMsg(pid, 'error', '未能插话：本轮已结束，请重新发送'); $('#input').value = text; renderHeader(); }
  } catch (e) { addMsg(pid, 'error', '插话失败：' + e.message); $('#input').value = text; renderHeader(); }
}
async function send(text) {
  if (!current || !text.trim()) return;
  if (isBusy(current)) return interject(text);
  const projectId = current.id, sid = currentSession, pid = viewKey();
  $('#input').value = '';
  streams.set(projectId, true); renderHeader();
  addMsg(pid, 'user', text);
  showThinking(pid, '思考中…');
  try {
    const res = await fetch(`/api/projects/${projectId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, session: sid }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readEvents(res, pid, (p, ev) => { handleEvent(p, ev); return p; });
  } catch (e) { addMsg(pid, 'error', e.message); }
  finally { streams.delete(projectId); stopDone(projectId); wasBusy.set(projectId, false); hideThinking(pid); dropLive(pid); renderHeader(); loadProjects(); if (sameProject(pid)) loadSessions(true); followNext(projectId); }
}
// The server started the next turn from the message queue right after this one ended: attach to it (renders the merged user message first).
const autoNext = new Set();
function followNext(projectId) {
  if (!autoNext.delete(projectId)) return;
  if (current?.id === projectId) { current.busy = true; wasBusy.set(projectId, true); loadHistory(); }
  else attach(projectId);
}

// ---------- message queue (held back until the current run ends, then sent together) ----------
function renderQueue(projectId, items) {
  if (current?.id !== projectId) return;
  const bar = $('#queueBar'), list = $('#queueList');
  bar.hidden = !items.length; $('#queueCount').textContent = items.length; list.innerHTML = '';
  for (const q of items) {
    const li = document.createElement('li'); li.title = q.text;
    li.innerHTML = `<span>${esc(q.text)}</span><button type="button" title="移出队列">✕</button>`;
    li.querySelector('button').onclick = async () => { try { renderQueue(projectId, (await api(`/api/projects/${projectId}/chat/queue/${q.id}`, { method: 'DELETE' })).items); } catch {} };
    list.appendChild(li);
  }
}
async function loadQueue() {
  if (!current) { $('#queueBar').hidden = true; return; }
  const id = current.id;
  try { renderQueue(id, (await api(`/api/projects/${id}/chat/queue`)).items); } catch {}
}
/** Hold the text back; the server sends every queued message together as the next turn. Falls back to a normal send if idle. */
async function enqueue(text) {
  if (!current || !text.trim()) return;
  const projectId = current.id, pid = viewKey();
  $('#input').value = ''; renderHeader();
  try {
    const r = await api(`/api/projects/${projectId}/chat/queue`, { method: 'POST', body: { message: text, session: currentSession } });
    if (!r.queued) return send(text);
    renderQueue(projectId, r.items);
  } catch (e) { addMsg(pid, 'error', '排队失败：' + e.message); $('#input').value = text; renderHeader(); }
}
$('#queueBtn').onclick = () => enqueue($('#input').value);
$('#queueClear').onclick = async () => { if (!current) return; try { renderQueue(current.id, (await api(`/api/projects/${current.id}/chat/queue`, { method: 'DELETE' })).items); } catch {} };

// ---------- stop ----------
const stopping = new Set(); // projectIds with a pending stop request
async function stop() {
  if (!current || !isBusy(current) || stopping.has(current.id)) return;
  const id = current.id;
  stopping.add(id); renderHeader();
  try { await api(`/api/projects/${id}/chat/stop`, { method: 'POST' }); }
  catch (e) { stopping.delete(id); renderHeader(); addMsg(viewKey(), 'error', '停止失败：' + e.message); }
}
function stopDone(projectId) { stopping.delete(projectId); }

function handleEvent(pid, ev) {
  switch (ev.type) {
    case 'thinking': showThinking(pid, `思考中… (第 ${ev.iteration} 轮)`); break;
    case 'stopping': showThinking(pid, '正在停止…'); break;
    case 'interjected': addInterjection(pid, ev.content); break;
    case 'queue': renderQueue(String(pid).split(':')[0], ev.items); break;
    case 'next': autoNext.add(String(pid).split(':')[0]); break;
    case 'usage': renderUsage(pid, ev); UsageDialog.refreshSummary(); break;
    case 'context': renderContext(pid, ev); break;
    case 'delta': onDelta(pid, ev); break;
    case 'reasoning': finishReasoning(pid, ev.content); break;
    case 'text': finishText(pid, ev.content); break;
    case 'tool_call': addTool(pid, ev.name, ev.args); break;
    case 'tool_result': addToolResult(pid, ev.name, ev.preview); break;
    case 'restarting': addSys(pid, '↻ 文件已修改，重启项目…'); break;
    case 'restarted': addSys(pid, ev.status === 'running' ? '✓ 项目已重启' : '✗ 重启后状态: ' + ev.status); if (ev.status === 'running' && sameProject(pid)) setTimeout(reloadFrame, 400); break;
    case 'snapshot': addUndo(pid, ev); break;
    case 'web_errors': addSys(pid, `⚠ 预览页面报告了 ${ev.count} 个前端错误，已交给 AI 处理`); break;
    case 'done': finishText(pid, ev.content); if (ev.stopped) addSys(pid, '■ 已停止'); if (sameProject(pid)) reloadFrame(); break;
    case 'error': addMsg(pid, 'error', ev.message); break;
  }
}

function reloadFrame() { const f = $('#frame'); if (current?.hasUi) f.src = `/p/${current.id}/?t=${Date.now()}`; }

// ---------- settings (fixed panel) ----------
async function loadSettings() {
  settings = await api('/api/settings');
  const ok = settings.hasKey && settings.baseUrl && settings.model;
  $('#llmBadge').className = 'badge ' + (ok ? 'ok' : '');
  $('#llmLabel').textContent = ok ? `⚙ ${settings.model}` : '⚙ 模型未配置';
  $('#openSettings').title = ok ? `${settings.baseUrl} · ${settings.model}` : '点击配置模型';
  const sel = $('#stPreset'); sel.innerHTML = '';
  for (const p of settings.presets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); }
  const match = settings.presets.find(p => p.baseUrl && p.baseUrl === settings.baseUrl);
  sel.value = match ? match.id : 'custom';
  $('#stBase').value = settings.baseUrl; $('#stModel').value = settings.model; $('#stKey').value = '';
  $('#stKey').placeholder = settings.hasKey ? `已配置 ${settings.apiKey}（留空保持不变）` : 'sk-…';
  $('#stTemp').value = settings.temperature; $('#stIter').value = settings.maxIterations; $('#stCtx').value = settings.contextWindow; $('#stStream').checked = settings.stream !== false;
  // project-side LLM
  const pl = settings.projectLlm;
  $('#stUseShell').checked = pl.useShell;
  $('#stProjectFields').hidden = pl.useShell;
  const psel = $('#stpPreset'); psel.innerHTML = '';
  for (const p of settings.presets) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; psel.appendChild(o); }
  const pmatch = settings.presets.find(p => p.baseUrl && p.baseUrl === pl.baseUrl);
  psel.value = pmatch ? pmatch.id : 'custom';
  $('#stpBase').value = pl.baseUrl; $('#stpModel').value = pl.model; $('#stpKey').value = '';
  $('#stpKey').placeholder = pl.hasKey ? `已配置 ${pl.apiKey}（留空保持不变）` : 'sk-…';
  const eff = settings.effectiveProjectLlm;
  $('#openSettings').title += `\n项目内 AI: ${eff.source === 'shell' ? '同壳配置' : '独立配置'} · ${eff.model || '未配置'}`;
}
function collectProjectLlm() {
  const pl = { useShell: $('#stUseShell').checked, baseUrl: $('#stpBase').value, model: $('#stpModel').value };
  if ($('#stpKey').value) pl.apiKey = $('#stpKey').value;
  return pl;
}
$('#stUseShell').onchange = () => { $('#stProjectFields').hidden = $('#stUseShell').checked; };
$('#stpPreset').onchange = () => { const p = settings.presets.find(x => x.id === $('#stpPreset').value); if (p && p.baseUrl) { $('#stpBase').value = p.baseUrl; $('#stpModel').value = p.model; } };
$('#stpTest').onclick = async () => {
  $('#stpResult').textContent = '测试中…';
  try { const saved = await saveSettings(); const r = await api('/api/settings/test-project', { method: 'POST' });
    $('#stpResult').textContent = `✓ 项目侧连接成功 ${r.ms}ms · ${r.source === 'shell' ? '同壳配置' : '独立配置'} · ${r.model}` + (saved.restarted?.length ? ` · 已重启 ${saved.restarted.length} 个项目` : ''); }
  catch (e) { $('#stpResult').textContent = '✗ ' + e.message; }
};
function toggleSettings(open) {
  const dlg = $('#settingsPanel');
  const show = open ?? !dlg.open;
  if (show) { $('#stResult').textContent = ''; $('#stpResult').textContent = ''; if (!dlg.open) dlg.showModal(); }
  else if (dlg.open) dlg.close();
}
async function saveSettings() {
  const body = { baseUrl: $('#stBase').value, model: $('#stModel').value, temperature: $('#stTemp').value, maxIterations: $('#stIter').value, contextWindow: $('#stCtx').value, stream: $('#stStream').checked, projectLlm: collectProjectLlm() };
  if ($('#stKey').value) body.apiKey = $('#stKey').value;
  const saved = await api('/api/settings', { method: 'PUT', body });
  await loadSettings();
  loadContext();
  if (saved.restarted?.length) { loadProjects(); if (current && saved.restarted.includes(current.id)) setTimeout(reloadFrame, 600); }
  return saved;
}
$('#stPreset').onchange = () => { const p = settings.presets.find(x => x.id === $('#stPreset').value); if (p && p.baseUrl) { $('#stBase').value = p.baseUrl; $('#stModel').value = p.model; } };
$('#settingsPanel form').onsubmit = async e => { e.preventDefault(); try { const saved = await saveSettings(); $('#stResult').textContent = '✓ 已保存' + (saved.restarted?.length ? `，已重启 ${saved.restarted.length} 个项目使新配置生效` : ''); } catch (err) { $('#stResult').textContent = '✗ ' + err.message; } };
$('#stTest').onclick = async () => {
  $('#stResult').textContent = '测试中…';
  try { await saveSettings(); const r = await api('/api/settings/test', { method: 'POST' }); $('#stResult').textContent = `✓ 连接成功 ${r.ms}ms，回复: ${r.reply}`; }
  catch (e) { $('#stResult').textContent = '✗ ' + e.message; }
};
$('#openSettings').onclick = async () => { await loadSettings(); toggleSettings(true); };
$('#stClose').onclick = () => toggleSettings(false);

// ---------- new project ----------
$('#newProject').onclick = async () => {
  const types = await api('/api/project-types');
  const sel = $('#npType'); sel.innerHTML = '';
  for (const t of types) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; o.disabled = !t.available; sel.appendChild(o); }
  $('#npName').value = ''; $('#npDesc').value = ''; $('#npStatus').textContent = '';
  $('#dlgNew').showModal(); $('#npDesc').focus();
};
$('#npGen').onclick = async () => {
  const description = $('#npDesc').value.trim();
  if (!description) { $('#npStatus').textContent = '请先填写「你想做什么」'; $('#npDesc').focus(); return; }
  $('#npGen').disabled = true; $('#npStatus').textContent = 'AI 正在起名…';
  try { const r = await api('/api/projects/name', { method: 'POST', body: { description } }); $('#npName').value = r.name; $('#npStatus').textContent = ''; }
  catch (err) { $('#npStatus').textContent = '✗ ' + err.message; }
  finally { $('#npGen').disabled = false; }
};
$('#dlgNew form').onsubmit = async e => {
  if (e.submitter?.value !== 'ok') return;
  const name = $('#npName').value.trim(), description = $('#npDesc').value.trim(), type = $('#npType').value;
  if (!description) { e.preventDefault(); $('#npStatus').textContent = '请填写「你想做什么」'; $('#npDesc').focus(); return; }
  if (!name) $('#npStatus').textContent = 'AI 正在起名并创建项目…';
  try {
    const p = await api('/api/projects', { method: 'POST', body: { name, description, type } });
    await loadProjects(); await select(p.id);
    send(`请根据以下需求改造这个项目：\n${description}`);
  } catch (err) { alert(err.message); }
};

// ---------- actions ----------
$('#btnRestart').onclick = async () => { await api(`/api/projects/${current.id}/restart`, { method: 'POST' }); await loadProjects(); reloadFrame(); };
$('#btnToggle').onclick = async () => {
  const live = current.status === 'running' || current.status === 'starting';
  $('#btnToggle').disabled = true;
  try { await api(`/api/projects/${current.id}/${live ? 'stop' : 'start'}`, { method: 'POST' }); }
  finally { await loadProjects(); if (!live) reloadFrame(); }
};
$('#btnReload').onclick = reloadFrame;
$('#btnClear').onclick = async () => { if (confirm('清空当前会话的对话记录？（不影响代码，项目累计 token 保留）')) { await api(`/api/projects/${current.id}/history?session=${encodeURIComponent(currentSession || '')}`, { method: 'DELETE' }); await Promise.all([loadSessions(true), loadHistory(), loadUsage()]); } };
$('#btnDelete').onclick = async () => {
  if (!confirm(`删除项目「${current.name}」及其全部文件？不可恢复。`)) return;
  await api(`/api/projects/${current.id}`, { method: 'DELETE' });
  current = null; currentSession = null; $('#frame').src = 'about:blank'; $('#messages').innerHTML = ''; $('#usage').hidden = true; $('#sessionBar').hidden = true; $('#queueBar').hidden = true;
  await loadProjects();
};
$('#btnLogs').onclick = async () => {
  const logs = await api(`/api/projects/${current.id}/logs`);
  $('#panelTitle').textContent = '运行日志';
  $('#panelBody').onclick = null;
  $('#panelBody').innerHTML = logs.map(l => `<span class="${l.stream}">${esc(l.line)}</span>`).join('\n') || '(无日志)';
  $('#dlgPanel').showModal(); $('#panelBody').scrollTop = 1e9;
};
$('#btnFiles').onclick = async () => {
  const files = await api(`/api/projects/${current.id}/files`);
  $('#panelTitle').textContent = `文件 · projects/${current.id}/`;
  $('#panelBody').innerHTML = files.map(f => f.endsWith('/') ? `<span class="sys">${esc(f)}</span>` : `<a data-f="${esc(f)}">${esc(f)}</a>`).join('\n');
  $('#panelBody').onclick = async e => { const f = e.target.dataset?.f; if (!f) return;
    const txt = await (await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(f)}`)).text();
    $('#panelTitle').textContent = f; $('#panelBody').textContent = txt; $('#panelBody').onclick = null; };
  $('#dlgPanel').showModal();
};
$('#panelClose').onclick = () => $('#dlgPanel').close();

// ---------- versions (per-turn snapshots) ----------
/** End of a turn that changed code: offer a one-click undo right in the conversation. */
function addUndo(pid, ev) {
  const d = addSys(pid, `✓ 已保存本轮之前的版本（本轮改动 ${ev.changedCount} 个文件）`);
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost undo'; b.textContent = '撤销本轮';
  b.onclick = () => restoreVersion(pid.split(':')[0], ev.id);
  d.appendChild(b);
}
async function restoreVersion(projectId, vid, label) {
  if (!confirm(`把代码回滚到${label ? `「${label}」` : '本轮'}开始前的版本？\n业务数据不受影响；回滚前的状态会另存为一个版本，可再切回。`)) return false;
  try {
    const r = await api(`/api/projects/${projectId}/snapshots/${vid}/restore`, { method: 'POST' });
    if (current?.id === projectId) { await loadHistory(); reloadFrame(); }
    loadProjects();
    if (r.status !== 'running') alert('已回滚，但项目启动状态为 ' + r.status + '，可查看日志');
    return true;
  } catch (e) { alert('回滚失败：' + e.message); return false; }
}
async function openVersions() {
  const id = current.id;
  $('#vsName').textContent = current.name;
  const list = await api(`/api/projects/${id}/snapshots`);
  const ul = $('#vsList'); ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted small">还没有版本。AI 每次修改代码前会自动保存。</li>';
  for (const v of list) {
    const li = document.createElement('li'); li.className = v.kind;
    const files = v.changed?.length ? `本轮改动: ${v.changed.slice(0, 6).join(', ')}${v.changedCount > 6 ? ` 等 ${v.changedCount} 个` : ''}` : v.kind === 'backup' ? '回滚前的完整代码' : '';
    li.innerHTML = `<div class="vmain"><div class="vlabel"></div><div class="muted small">${esc(new Date(v.ts).toLocaleString())} · ${v.files} 个文件</div><div class="vfiles"></div></div><button class="ghost">回滚到此前</button>`;
    li.querySelector('.vlabel').textContent = v.kind === 'backup' ? '↺ ' + v.label : v.label || '（无描述）';
    li.querySelector('.vfiles').textContent = files; li.querySelector('.vfiles').title = (v.changed || []).join('\n');
    li.querySelector('button').title = v.kind === 'backup' ? '恢复到那次回滚之前的代码' : '恢复到这一轮对话开始前的代码';
    li.querySelector('button').onclick = async () => { if (isBusy(current)) return alert('AI 正在处理，请先停止或等待完成'); if (await restoreVersion(id, v.id, v.label)) openVersions(); };
    ul.appendChild(li);
  }
  if (!$('#dlgVersions').open) $('#dlgVersions').showModal();
}
$('#btnVersions').onclick = openVersions;
$('#vsClose').onclick = () => $('#dlgVersions').close();

// ---------- export / deploy ----------
const fmtBytes = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
async function openExport() {
  const id = current.id;
  $('#exName').textContent = current.name;
  $('#exZip').href = `/api/projects/${id}/export`;
  $('#exLog').hidden = true; $('#exLog').textContent = ''; $('#exRunWrap').hidden = true; $('#exSave').hidden = true; $('#exImageInfo').textContent = '';
  $('#exBuild').disabled = true; $('#exBuild').textContent = '🐳 构建镜像';
  $('#exDockerStatus').textContent = '检测 Docker…'; $('#exDockerStatus').className = 'small muted';
  $('#dlgExport').showModal();
  try {
    const r = await api(`/api/projects/${id}/image`);
    if (current?.id !== id) return;
    $('#exZipRun').textContent = r.hints.zipRun;
    const st = $('#exDockerStatus');
    if (r.docker.available) { st.textContent = `✓ Docker ${r.docker.version} 可用`; st.className = 'small ok'; $('#exBuild').disabled = r.building; if (r.building) $('#exBuild').textContent = '构建中…'; }
    else { st.textContent = '✗ ' + r.docker.reason + (r.docker.detail ? `（${r.docker.detail}）` : ''); st.className = 'small bad'; }
    showImage(id, r.image, r.hints);
  } catch (e) { $('#exDockerStatus').textContent = '✗ ' + e.message; $('#exDockerStatus').className = 'small bad'; }
}
function showImage(id, image, hints) {
  if (!image) return;
  $('#exImageInfo').textContent = `已有镜像 ${image.tag} · ${fmtBytes(image.size)} · ${new Date(image.created).toLocaleString()}`;
  $('#exSave').hidden = false; $('#exSave').href = `/api/projects/${id}/image.tar.gz`;
  $('#exRun').textContent = `${hints.dockerLoad}\n${hints.dockerRun}`;
  $('#exRunWrap').hidden = false;
}
$('#btnExport').onclick = openExport;
$('#exClose').onclick = () => $('#dlgExport').close();
$('#exBuild').onclick = async () => {
  const id = current.id, log = $('#exLog'), btn = $('#exBuild');
  btn.disabled = true; btn.textContent = '构建中…'; log.hidden = false; log.textContent = ''; $('#exRunWrap').hidden = true;
  const append = (cls, line) => { const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40; const el = document.createElement('span'); el.className = cls; el.textContent = line + '\n'; log.appendChild(el); if (atEnd) log.scrollTop = log.scrollHeight; };
  try {
    const res = await fetch(`/api/projects/${id}/image`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readEvents(res, id, (_, ev) => {
      if (ev.type === 'line') append(ev.stream === 'err' ? 'sys' : 'out', ev.line);
      else if (ev.type === 'error') append('err', '✗ ' + ev.message);
      else if (ev.type === 'done') {
        append(ev.ok ? 'ok' : 'err', ev.ok ? `✓ 构建完成 ${ev.image.tag} · ${fmtBytes(ev.image.size)} · ${(ev.ms / 1000).toFixed(1)}s` : `✗ 构建失败 (exit ${ev.code})`);
        if (ev.ok) showImage(id, ev.image, ev.hints);
      }
    });
  } catch (e) { append('err', '✗ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '🐳 重新构建'; }
};
$('#composer').onsubmit = e => { e.preventDefault(); isBusy(current) ? stop() : send($('#input').value); };
$('#input').onkeydown = e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && isBusy(current)) { e.preventDefault(); return enqueue($('#input').value); }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#input').value); }
  if (e.key === 'Escape' && isBusy(current)) { e.preventDefault(); stop(); }
};
$('#input').oninput = () => { if (isBusy(current)) renderHeader(); };

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeParse = s => { try { return JSON.parse(s); } catch { return {}; } };
const firstLine = s => String(s ?? '').split('\n')[0].replace(/^\[系统\]\s*/, '↻ ').slice(0, 120);

$('#tokenStats').onclick = () => UsageDialog.open('today');

// ---------- sidebar collapse ----------
function setSidebar(collapsed) {
  document.body.classList.toggle('sb-collapsed', collapsed);
  const b = $('#sbToggle'); b.textContent = collapsed ? '»' : '«';
  b.title = b.ariaLabel = (collapsed ? '展开侧栏' : '折叠侧栏') + ' (⌘/Ctrl+B)';
  try { localStorage.setItem('sbCollapsed', collapsed ? '1' : '0'); } catch {}
}
setSidebar(localStorage.getItem('sbCollapsed') === '1');
$('#sbToggle').onclick = () => setSidebar(!document.body.classList.contains('sb-collapsed'));
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(!document.body.classList.contains('sb-collapsed')); } });

(async () => {
  UsageDialog.refreshSummary();
  setInterval(() => UsageDialog.refreshSummary(), 60000);
  await loadSettings();
  await loadProjects();
  if (projects.length) await select(projects[0].id);
  renderHeader();
  if (!settings.hasKey) toggleSettings(true);
  setInterval(loadProjects, 5000);
})();
