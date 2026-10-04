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
  renderHeader(); renderBoard();
}

async function select(id) {
  document.body.classList.remove('view-board');
  if (isPhone()) setTab('chat'); // picking a project on a phone goes straight to its conversation
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
  for (const id of ['btnToggle', 'btnLogs', 'btnFiles', 'btnVersions', 'btnReport', 'btnShare', 'btnFeedback', 'btnMore', 'btnDuplicate', 'btnExport', 'btnDelete']) $('#' + id).disabled = !has;
  const fbn = has ? current.feedbackNew || 0 : 0;
  $('#fbBadge').hidden = !fbn; $('#fbBadge').textContent = fbn;
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
  $('#mBusy').hidden = !busy;
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
    if (m.role === 'user') { m.image ? addShot(pid, m.image, firstLine(m.content)) : m.system ? addSys(pid, firstLine(m.content)) : m.interjection ? addInterjection(pid, m.content) : addMsg(pid, 'user', m.content); continue; }
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
    : name === 'page_view' ? `${args.device === 'mobile' ? '📱 ' : ''}${args.path || '当前页面'}`
    : name === 'page_act' ? (args.device === 'mobile' ? '📱 ' : '') + (args.actions || []).map(a => `${a.type}${a.ref ? ' ' + a.ref : ''}${a.value != null && a.value !== '' ? ' ' + JSON.stringify(a.value).slice(0, 24) : ''}`).join(' → ')
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
const FIRST_BUILD_BUDGET = 50; // validation demos: fast first version, iterate afterwards
async function send(text, opts = {}) {
  if (!current || !text.trim()) return;
  if (isBusy(current)) return interject(text);
  const projectId = current.id, sid = currentSession, pid = viewKey();
  $('#input').value = '';
  streams.set(projectId, true); renderHeader();
  addMsg(pid, 'user', text);
  showThinking(pid, '思考中…');
  try {
    const res = await fetch(`/api/projects/${projectId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, session: sid, budget: opts.budget }) });
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
    case 'browser': { const projectId = String(pid).split(':')[0]; PageBot.handle(projectId, ev, current?.id === projectId && current.hasUi ? $('#frame') : null).finally(() => pageBotBusy.delete(ev.reqId)); pageBotBusy.add(ev.reqId); break; }
    case 'shot': addShot(pid, ev.file, '页面截图（' + ev.info + '）'); break;
    case 'gate': addSys(pid, `🔍 收尾前自检：${[ev.leftover?.length && `清理没改过的骨架页（${ev.leftover.join('、')}）`, ev.missing?.length && `在${ev.missing.join('和')}尺寸下检查页面`].filter(Boolean).join('；')}`); break;
    case 'vision_off': addSys(pid, '当前模型不接受图片，已改为只发送页面结构文本（可在模型设置中调整）'); break;
    case 'web_errors': addSys(pid, `⚠ 预览页面报告了 ${ev.count} 个前端错误，已交给 AI 处理`); break;
    case 'done': finishText(pid, ev.content); if (ev.stopped) addSys(pid, '■ 已停止'); if (sameProject(pid)) reloadFrame(); if (!ev.stopped) nudgePretest(pid); break;
    case 'error': addMsg(pid, 'error', ev.message); break;
  }
}

// while the agent is operating the preview, an automatic reload would wipe what it is doing
const pageBotBusy = new Set();
function reloadFrame() { const f = $('#frame'); if (current?.hasUi && !pageBotBusy.size) f.src = `/p/${current.id}/?t=${Date.now()}`; }
function addShot(pid, file, label) {
  const d = addSys(pid, '📷 ' + label.replace(/^↻\s*/, ''));
  const projectId = String(pid).split(':')[0];
  const img = document.createElement('img'); img.className = 'shot'; img.loading = 'lazy'; img.alt = 'AI 看到的页面';
  img.src = `/api/projects/${projectId}/shots/${file}`;
  img.onclick = () => window.open(img.src, '_blank');
  d.appendChild(img);
  return d;
}

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
  $('#stVision').value = settings.vision || 'auto';
  $('#stVisionState').textContent = settings.vision === 'auto' ? (settings.visionOk === true ? '已检测：当前模型支持图片' : settings.visionOk === false ? `已检测：当前模型不支持图片，只发送页面结构文本${settings.visionError ? `（${settings.visionError.slice(0, 120)}）` : ''}；如判断有误，把上面切到「总是发送」或重新保存即可重新检测` : '尚未检测（AI 第一次查看页面时自动判断）') : '';
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
  const body = { baseUrl: $('#stBase').value, model: $('#stModel').value, temperature: $('#stTemp').value, maxIterations: $('#stIter').value, contextWindow: $('#stCtx').value, stream: $('#stStream').checked, vision: $('#stVision').value, projectLlm: collectProjectLlm() };
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

// ---------- new project: requirement -> plan (editable) -> create + first message ----------
let planDesc = '', skeletons = [], lastPlan = null;
const npStep = n => { $('#npStep1').hidden = n !== 1; $('#npStep2').hidden = n !== 2; };
$('#newProject').onclick = async () => {
  const [types, sks] = await Promise.all([api('/api/project-types'), api('/api/skeletons')]);
  skeletons = sks;
  const sel = $('#npType'); sel.innerHTML = '';
  for (const t of types) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; o.disabled = !t.available; sel.appendChild(o); }
  $('#npDesc').value = ''; $('#npStatus').textContent = '';
  npStep(1); $('#dlgNew').showModal(); $('#npDesc').focus();
};
$('#npCancel').onclick = () => $('#dlgNew').close();
$('#npType').onchange = () => { const web = $('#npType').value === 'web'; $('#npPlan').hidden = !web; $('#npSkip').textContent = web ? '跳过方案直接做' : '创建并开始'; };

// list editors for the plan: one input per item
function ppList(key, items) {
  const box = document.querySelector(`.pp-list[data-key="${key}"]`);
  box.querySelectorAll('.pp-item, .pp-add').forEach(e => e.remove());
  const add = (v = '') => {
    const row = document.createElement('div'); row.className = 'pp-item';
    row.innerHTML = '<input><button type="button" class="ghost" title="删除">✕</button>';
    row.querySelector('input').value = v;
    row.querySelector('button').onclick = () => row.remove();
    box.insertBefore(row, btn); return row;
  };
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ghost pp-add'; btn.textContent = '+ 添加';
  btn.onclick = () => add().querySelector('input').focus();
  box.appendChild(btn);
  for (const v of items) add(v);
}
const ppValues = key => [...document.querySelectorAll(`.pp-list[data-key="${key}"] .pp-item input`)].map(i => i.value.trim()).filter(Boolean);
const splitOnce = s => { const m = s.match(/^(.*?)[：:](.*)$/); return m ? [m[1].trim(), m[2].trim()] : [s.trim(), '']; };

function showPlan(plan) {
  lastPlan = plan;
  $('#ppSketch').textContent = '🎨 画草图对比';
  $('#ppName').value = plan.name || '';
  const sel = $('#ppSkeleton'); sel.innerHTML = '';
  for (const k of skeletons) { const o = document.createElement('option'); o.value = k.id; o.textContent = k.label; o.title = k.fit; o.disabled = !k.available; sel.appendChild(o); }
  sel.value = plan.skeleton;
  $('#ppSummary').value = plan.summary || '';
  ppList('pages', plan.pages.map(p => p.purpose ? `${p.name}：${p.purpose}` : p.name));
  ppList('data', plan.data.map(d => `${d.name}：${d.fields.join('、')}`));
  ppList('flows', plan.flows); ppList('highlights', plan.highlights); ppList('outOfScope', plan.outOfScope); ppList('signals', plan.signals || []);
  $('#ppHyp').value = plan.hypothesis || '';
  $('#ppSample').value = plan.sampleData || ''; $('#ppNotes').value = ''; $('#ppStatus').textContent = '';
  renderDesigns(plan.designs || [], plan.design || 0);
  npStep(2);
}
const LOOK_NAMES = { clean: '干净通用', industrial: '工业现场', warm: '温暖服务', bold: '活力醒目', editorial: '克制专业', compact: '紧凑数据' };
const LAYOUT_NAMES = { topbar: '顶栏', sidebar: '侧边栏', tabbar: '手机底栏', hero: '首屏横幅', board: '状态墙' };
let planDesign = 0;
function renderDesigns(list, chosen) {
  planDesign = Math.min(chosen, Math.max(0, list.length - 1));
  const box = $('#ppDesigns'); box.innerHTML = '';
  box.previousElementSibling.hidden = box.hidden = !list.length;
  list.forEach((d, i) => {
    const el = document.createElement('div'); el.className = 'pp-design' + (i === planDesign ? ' on' : '');
    el.innerHTML = `<b></b><div class="why"></div><div class="tags"></div>`;
    el.querySelector('b').textContent = (i === 0 ? '⭐ ' : '') + d.name;
    el.querySelector('.why').textContent = d.why;
    el.querySelector('.tags').innerHTML = [LOOK_NAMES[d.look], ...d.layout.split('+').map(x => LAYOUT_NAMES[x]), d.color, ...d.signature].filter(Boolean).map(t => `<span>${esc(t)}</span>`).join('');
    el.onclick = () => { planDesign = i; box.querySelectorAll('.pp-design').forEach((x, j) => x.classList.toggle('on', j === i)); };
    box.appendChild(el);
    if (lastPlan?.sketches?.[i]) showSketchThumb(el, lastPlan.sketches[i]);
  });
  $('#ppSketch').hidden = !list.length;
}

// ---------- design sketches: a static mock of the core screen per direction, to compare before building ----------
let sdCss = null;
async function sketchDoc(html) {
  sdCss ??= await fetch('/_sd/sd.css').then(r => r.text()).catch(() => '');
  return html.replace(/<link[^>]*_sd\/sd\.css[^>]*>/i, () => `<style>${sdCss}</style>`);
}
async function showSketchThumb(card, html) {
  card.querySelector('.pp-sk')?.remove();
  const wrap = document.createElement('div'); wrap.className = 'pp-sk'; wrap.title = '点击放大';
  const f = document.createElement('iframe'); f.setAttribute('sandbox', ''); f.tabIndex = -1; f.srcdoc = await sketchDoc(html);
  wrap.appendChild(f); card.insertBefore(wrap, card.firstChild);
  const fit = () => { f.style.transform = `scale(${wrap.clientWidth / 1280})`; };
  fit(); new ResizeObserver(fit).observe(wrap);
  wrap.onclick = async e => { e.stopPropagation(); card.click(); $('#skFrame').srcdoc = await sketchDoc(html); $('#skTitle').textContent = card.querySelector('b').textContent; $('#dlgSketch').showModal(); };
}
$('#skClose').onclick = () => $('#dlgSketch').close();
$('#ppSketch').onclick = async () => {
  const plan = lastPlan; if (!plan?.designs?.length) return;
  const btn = $('#ppSketch'); btn.disabled = true;
  const cards = [...$('#ppDesigns').children], current = readPlan();
  plan.sketches ||= [];
  $('#ppStatus').textContent = `正在为 ${cards.length} 个方向画草图（约 1 分钟）…`;
  let fail = 0;
  await Promise.all(cards.map(async (card, i) => {
    card.querySelector('.pp-sk')?.remove();
    card.insertAdjacentHTML('afterbegin', '<div class="pp-sk loading">绘制中…</div>');
    try {
      const { html } = await api('/api/projects/sketch', { method: 'POST', body: { plan: { ...current, design: i }, index: i, description: planDesc } });
      if (lastPlan !== plan) return;
      plan.sketches[i] = html; await showSketchThumb(card, html);
    } catch (e) { fail++; const l = card.querySelector('.pp-sk.loading'); if (l) l.textContent = '✗ ' + e.message; }
  }));
  if (lastPlan === plan) $('#ppStatus').textContent = fail ? `${fail} 张草图失败，可以再点一次` : '草图好了：点开放大对比，选中的那张会交给 AI 照着做';
  btn.disabled = false; btn.textContent = '🎨 重画草图';
};
function readPlan() {
  return {
    name: $('#ppName').value.trim(), skeleton: $('#ppSkeleton').value, summary: $('#ppSummary').value.trim(),
    users: lastPlan?.users || [], pages: ppValues('pages').map(v => { const [name, purpose] = splitOnce(v); return { name, purpose }; }),
    data: ppValues('data').map(v => { const [name, f] = splitOnce(v); return { name, fields: f.split(/[、,，;；]/).map(x => x.trim()).filter(Boolean) }; }),
    flows: ppValues('flows'), sampleData: $('#ppSample').value.trim(), highlights: ppValues('highlights'), outOfScope: ppValues('outOfScope'),
    notes: $('#ppNotes').value.trim(),
    designs: lastPlan?.designs || [], design: planDesign,
    hypothesis: $('#ppHyp').value.trim(), signals: ppValues('signals'),
  };
}
async function genPlan(statusEl) {
  const btns = ['#npPlan', '#ppRegen', '#ppOk'].map(s => $(s)); btns.forEach(b => b.disabled = true);
  statusEl.textContent = 'AI 正在出方案（约 10–30 秒）…';
  try { const { plan } = await api('/api/projects/plan', { method: 'POST', body: { description: planDesc } }); showPlan(plan); }
  catch (e) { statusEl.textContent = '✗ ' + e.message; }
  finally { btns.forEach(b => b.disabled = false); }
}
$('#npPlan').onclick = () => {
  planDesc = $('#npDesc').value.trim();
  if (!planDesc) { $('#npStatus').textContent = '请先写一句你想做什么'; $('#npDesc').focus(); return; }
  genPlan($('#npStatus'));
};
$('#ppRegen').onclick = () => genPlan($('#ppStatus'));
$('#ppBack').onclick = () => npStep(1);
async function createAndStart(body, statusEl, btn) {
  btn.disabled = true; statusEl.textContent = '正在创建项目…';
  try {
    const p = await api('/api/projects', { method: 'POST', body });
    $('#dlgNew').close();
    await loadProjects(); await select(p.id);
    send(p.firstMessage, { budget: FIRST_BUILD_BUDGET });
  } catch (e) { statusEl.textContent = '✗ ' + e.message; }
  finally { btn.disabled = false; }
}
$('#ppOk').onclick = () => createAndStart({ description: planDesc, type: 'web', name: $('#ppName').value.trim(), plan: readPlan(), sketch: lastPlan?.sketches?.[planDesign] || '' }, $('#ppStatus'), $('#ppOk'));
$('#npSkip').onclick = () => {
  const description = $('#npDesc').value.trim();
  if (!description) { $('#npStatus').textContent = '请先写一句你想做什么'; $('#npDesc').focus(); return; }
  createAndStart({ description, type: $('#npType').value }, $('#npStatus'), $('#npSkip'));
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
function setDevice(mobile) {
  $('#preview').classList.toggle('mobile', mobile);
  $('#btnDevice').textContent = mobile ? '💻 电脑' : '📱 手机';
  try { localStorage.setItem('previewMobile', mobile ? '1' : '0'); } catch {}
}
setDevice(localStorage.getItem('previewMobile') === '1');
$('#btnDevice').onclick = () => setDevice(!$('#preview').classList.contains('mobile'));
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

// ---------- share links ----------
const shareUrl = token => `${location.origin}/s/${token}/`;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { // http:// on a LAN address is not a secure context: no Clipboard API
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
/** A ready-to-send invite: what it is, the link, how long it takes, how to give feedback. */
function inviteText(url) {
  const plan = current.plan || {}, what = plan.summary || current.description || current.name;
  return `嗨～我在琢磨一个小想法：${what.replace(/。$/, '')}。做了个能点的 Demo，想请你花 2 分钟试一下（手机也能打开）：\n${url}\n试完点页面右下角「💬 说说看法」，告诉我对你有没有用、还缺什么就行，谢谢🙏`;
}
function showInvite(token) {
  const box = $('#shInviteBox'); if (!token) { box.hidden = true; return; }
  $('#shInvite').value = inviteText(shareUrl(token)); box.hidden = false;
}
$('#shInviteCopy').onclick = async e => { e.target.textContent = await copyText($('#shInvite').value) ? '已复制' : '复制失败'; setTimeout(() => { e.target.textContent = '复制话术'; }, 1500); };
async function openShare() {
  const id = current.id;
  $('#shName').textContent = current.name;
  $('#shHint').textContent = /^(localhost|127\.|\[::1\])/.test(location.hostname) ? '⚠ 你正通过本机地址访问，生成的链接只在这台电脑上能打开；请部署到服务器 / NAS 后再分享。' : '';
  const list = await api(`/api/projects/${id}/shares`);
  if (current?.id !== id) return;
  showInvite(list.find(x => x.active)?.token);
  const ul = $('#shList'); ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted small">还没有分享链接。</li>';
  for (const s of list) {
    const li = document.createElement('li'); li.className = s.active ? '' : 'revoked';
    const state = s.revoked ? '已关闭' : !s.active ? '已过期' : s.expiresAt ? `有效至 ${new Date(s.expiresAt).toLocaleString()}` : '永久有效';
    li.innerHTML = `<div class="vmain"><div class="surl"></div><div class="muted small"></div><div class="sstats" hidden></div></div><button class="ghost stat">统计</button>${s.active ? `<label class="check small" title="页面右下角显示「提意见」按钮"><input type="checkbox" class="fb"${s.feedback !== false ? ' checked' : ''}> 留言</label><button class="ghost copy">复制</button><button class="ghost danger off">关闭</button>` : ''}`;
    li.querySelector('.stat').onclick = async () => {
      const box = li.querySelector('.sstats');
      if (!box.hidden) { box.hidden = true; return; }
      const st = await api(`/api/projects/${id}/shares/${s.token}/stats`);
      const max = Math.max(1, ...st.days.map(d => d.views));
      box.innerHTML = `<span><b>${st.visitors}</b> 位访客 · <b>${st.views}</b> 次打开</span><span class="sbars" title="近 14 天每日打开次数">${st.days.map(d => `<i style="height:${Math.round(d.views / max * 100)}%" title="${d.date}：${d.views} 次 / ${d.visitors} 人"></i>`).join('')}</span>${st.pages.length ? `<span>常看页面：${st.pages.slice(0, 3).map(p => `${esc(p.page)} ×${p.views}`).join('，')}</span>` : ''}`;
      box.hidden = false;
    };
    if (s.active) li.querySelector('.fb').onchange = e => api(`/api/projects/${id}/shares/${s.token}`, { method: 'PATCH', body: { feedback: e.target.checked } });
    li.querySelector('.surl').textContent = shareUrl(s.token);
    li.querySelector('.small').textContent = [s.label, state, `打开 ${s.views || 0} 次`, s.lastViewAt ? `最近 ${new Date(s.lastViewAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
    if (s.active) {
      li.querySelector('.copy').onclick = async e => { e.target.textContent = await copyText(shareUrl(s.token)) ? '已复制' : '复制失败'; };
      li.querySelector('.off').onclick = async () => { if (!confirm('关闭后这个链接立即失效，确定？')) return; await api(`/api/projects/${id}/shares/${s.token}`, { method: 'DELETE' }); openShare(); };
    }
    ul.appendChild(li);
  }
  loadDemoData(); loadTour();
  if (!$('#dlgShare').open) $('#dlgShare').showModal();
}
$('#btnShare').onclick = openShare;
$('#shClose').onclick = () => $('#dlgShare').close();
$('#shCreate').onclick = async () => {
  const btn = $('#shCreate'); btn.disabled = true;
  try {
    const s = await api(`/api/projects/${current.id}/shares`, { method: 'POST', body: { days: $('#shDays').value, label: $('#shLabel').value } });
    $('#shLabel').value = '';
    const ok = await copyText(shareUrl(s.token));
    await openShare(); loadProjects();
    $('#shHint').textContent = ok ? '✓ 新链接已复制到剪贴板' : '链接已生成，请手动复制';
  } catch (e) { alert('生成失败：' + e.message); }
  finally { btn.disabled = false; }
};

// ---------- header "more" menu ----------
$('#btnMore').onclick = e => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('.more')) $('#moreMenu').hidden = true; });
$('#moreMenu').addEventListener('click', e => { if (e.target.closest('button')) $('#moreMenu').hidden = true; });

// ---------- duplicate ----------
$('#btnDuplicate').onclick = async () => {
  const name = prompt('新项目名称（复制代码和数据，对话记录从头开始）', `${current.name} 副本`);
  if (name === null) return;
  try { const p = await api(`/api/projects/${current.id}/duplicate`, { method: 'POST', body: { name: name.trim() } }); await loadProjects(); await select(p.id); }
  catch (e) { alert('复制失败：' + e.message); }
};

// ---------- visitor feedback ----------
let feedback = [];
async function openFeedback() {
  const id = current.id;
  $('#fbName').textContent = current.name;
  feedback = await api(`/api/projects/${id}/feedback`);
  if (current?.id !== id) return;
  const ul = $('#fbList'); ul.innerHTML = ''; $('#fbAll').checked = false;
  if (!feedback.length) ul.innerHTML = '<li class="muted small">还没有反馈。生成分享链接发给别人试用，他们点页面右下角「💬 提意见」就能留言。</li>';
  const ST = { new: '未处理', sent: '已交给 AI', done: '已处理' };
  for (const f of feedback) {
    const li = document.createElement('li'); li.className = 'st-' + f.status;
    li.innerHTML = `<input type="checkbox" data-id="${esc(f.id)}"><div class="vmain"><div class="fbtext"></div><div class="muted small"></div></div>`;
    li.querySelector('.fbtext').textContent = f.text;
    li.querySelector('.small').textContent = [ST[f.status], new Date(f.ts).toLocaleString(), f.name, f.page && f.page !== '/' ? '页面 ' + f.page : '', f.viewport && parseInt(f.viewport) < 600 ? '📱 手机' : '', f.share?.label ? '来自链接「' + f.share.label + '」' : ''].filter(Boolean).join(' · ');
    ul.appendChild(li);
  }
  if (!$('#dlgFeedback').open) $('#dlgFeedback').showModal();
}
const fbSelected = () => [...document.querySelectorAll('#fbList input[type=checkbox]:checked')].map(i => i.dataset.id);
$('#fbAll').onchange = () => { for (const i of document.querySelectorAll('#fbList input[type=checkbox]')) i.checked = $('#fbAll').checked && feedback.find(f => f.id === i.dataset.id)?.status === 'new'; };
$('#btnFeedback').onclick = openFeedback;
$('#fbClose').onclick = () => $('#dlgFeedback').close();
$('#fbDone').onclick = async () => { const ids = fbSelected(); if (!ids.length) return; await api(`/api/projects/${current.id}/feedback`, { method: 'PATCH', body: { ids, status: 'done' } }); openFeedback(); loadProjects(); };
$('#fbDel').onclick = async () => { const ids = fbSelected(); if (!ids.length || !confirm(`删除 ${ids.length} 条反馈？`)) return; await api(`/api/projects/${current.id}/feedback`, { method: 'DELETE', body: { ids } }); openFeedback(); loadProjects(); };
$('#fbSend').onclick = async () => {
  const ids = fbSelected(); if (!ids.length) return alert('先勾选要处理的反馈');
  const { message } = await api(`/api/projects/${current.id}/feedback/message`, { method: 'POST', body: { ids } });
  await api(`/api/projects/${current.id}/feedback`, { method: 'PATCH', body: { ids, status: 'sent' } });
  $('#dlgFeedback').close(); loadProjects();
  isBusy(current) ? enqueue(message) : send(message); // busy: queued as the next turn
};

// ---------- visitor tour (in the share dialog) ----------
function renderTour(t) {
  $('#tourTitle').value = t.title || ''; $('#tourIntro').value = t.intro || '';
  $('#tourSteps').value = (t.steps || []).map(s => s.page ? `${s.text} | ${s.page}` : s.text).join('\n');
  $('#tourOn').checked = !!t.enabled && !!t.steps?.length;
}
const readTour = () => ({ enabled: $('#tourOn').checked, title: $('#tourTitle').value, intro: $('#tourIntro').value,
  steps: $('#tourSteps').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [text, page = ''] = l.split('|').map(x => x.trim()); return { text, page }; }) });
async function loadTour() { try { renderTour(await api(`/api/projects/${current.id}/tour`)); $('#tourInfo').textContent = ''; } catch {} }
$('#tourGen').onclick = async () => {
  const b = $('#tourGen'); b.disabled = true; $('#tourInfo').textContent = 'AI 正在根据方案和页面写导览…';
  try { renderTour(await api(`/api/projects/${current.id}/tour/generate`, { method: 'POST' })); $('#tourInfo').textContent = '✓ 已生成并启用，访客下次打开链接就能看到'; }
  catch (e) { $('#tourInfo').textContent = '✗ ' + e.message; } finally { b.disabled = false; }
};
$('#tourSave').onclick = async () => { try { renderTour(await api(`/api/projects/${current.id}/tour`, { method: 'PUT', body: readTour() })); $('#tourInfo').textContent = '✓ 已保存'; } catch (e) { $('#tourInfo').textContent = '✗ ' + e.message; } };
$('#tourOn').onchange = () => $('#tourSave').click();

// ---------- demo data (in the share dialog) ----------
function renderDemoData(d) {
  $('#ddRestore').disabled = !d.saved; $('#ddDaily').disabled = !d.saved; $('#ddDaily').checked = d.daily;
  $('#ddInfo').textContent = d.saved ? `已保存于 ${new Date(d.saved.savedAt).toLocaleString()}（${d.saved.files} 个文件）${d.lastResetAt ? ` · 上次恢复 ${new Date(d.lastResetAt).toLocaleString()}` : ''}` : '尚未保存演示数据';
}
async function loadDemoData() { try { renderDemoData(await api(`/api/projects/${current.id}/demo-data`)); } catch {} }
$('#ddSave').onclick = async () => {
  if (!confirm('把项目当前的全部数据保存为演示初始状态？（会短暂重启项目）')) return;
  $('#ddSave').disabled = true;
  try { renderDemoData(await api(`/api/projects/${current.id}/demo-data/save`, { method: 'POST' })); } catch (e) { alert(e.message); } finally { $('#ddSave').disabled = false; }
};
$('#ddRestore').onclick = async () => {
  if (!confirm('把数据恢复到保存时的演示状态？之后新增或修改的数据会丢失。')) return;
  $('#ddRestore').disabled = true;
  try { renderDemoData(await api(`/api/projects/${current.id}/demo-data/restore`, { method: 'POST' })); reloadFrame(); } catch (e) { alert(e.message); } finally { $('#ddRestore').disabled = false; }
};
$('#ddDaily').onchange = async () => { try { renderDemoData(await api(`/api/projects/${current.id}/demo-data`, { method: 'PUT', body: { daily: $('#ddDaily').checked } })); } catch (e) { alert(e.message); } };

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

// ---------- idea board (home): ideas move building -> ready -> validating -> concluded ----------
const STAGES = [['building', '✍️', '制作中', '新想法在这里，AI 做好第一版就会往右移'], ['ready', '📤', '待分享', 'Demo 做好了：点卡片 → 分享，发给目标用户试'],
  ['validating', '🧪', '验证中', '已分享，等试用者表态和回答验证问题'], ['concluded', '✅', '有结论', '证据够了就在「📊 验证」里生成结论']];
function showBoard() { document.body.classList.add('view-board'); if (isPhone()) setTab('projects'); renderBoard(); }
function renderBoard() {
  if (!document.body.classList.contains('view-board')) return;
  const cols = $('#boardCols'); cols.innerHTML = '';
  for (const [stage, icon, title, hint] of STAGES) {
    const list = projects.filter(p => (p.validation?.stage || 'building') === stage);
    const col = document.createElement('div'); col.className = 'bcol';
    col.innerHTML = `<div class="bcol-head">${icon} <b>${title}</b><span class="n">${list.length}</span></div>`;
    if (!list.length) col.insertAdjacentHTML('beforeend', `<div class="bcol-empty">${hint}</div>`);
    for (const p of list) {
      const v = p.validation || {}, r = v.reactions || { up: 0, meh: 0, down: 0 }, total = r.up + r.meh + r.down;
      const card = document.createElement('div'); card.className = 'icard';
      card.innerHTML = `<div class="shot${v.thumb ? '' : ' none'}">${v.thumb ? '' : '◇'}</div><div class="body"><div class="name"><span class="dot ${p.status}"></span><span></span>${isBusy(p) ? '<span class="thinking small">⋯</span>' : ''}</div>
        <div class="hyp"></div><div class="sig">${total ? `<span class="rxbar" title="👍 ${r.up} · 🤔 ${r.meh} · 👎 ${r.down}"><i style="width:${r.up / total * 100}%;background:#3fb950"></i><i style="width:${r.meh / total * 100}%;background:#d29922"></i><i style="width:${r.down / total * 100}%;background:#e5534b"></i></span>` : ''}
        ${total ? `<span>👍${r.up} 🤔${r.meh} 👎${r.down}</span>` : ''}${!total && v.pretest ? `<span class="muted" title="AI 模拟试用（不算真实证据）">模拟 👍${v.pretest.up} 🤔${v.pretest.meh} 👎${v.pretest.down}</span>` : ''}${v.feedback ? `<span>💬 ${v.feedback}</span>` : ''}${v.verdict ? `<span class="verdict ${v.verdict}">${esc(v.verdictLabel)}</span>` : ''}</div></div>`;
      if (v.thumb) card.querySelector('.shot').style.backgroundImage = `url("/api/projects/${p.id}/shots/${v.thumb}")`;
      card.querySelector('.name span:nth-child(2)').textContent = p.name;
      card.querySelector('.hyp').textContent = v.hypothesis || p.description || '';
      card.onclick = () => select(p.id, true);
      col.appendChild(card);
    }
    cols.appendChild(col);
  }
}
$('#bdNew').onclick = () => $('#newProject').click();
$('#bdSettings').onclick = () => $('#openSettings').click();
document.querySelector('.brand-text').style.cursor = 'pointer';
document.querySelector('.brand-text').onclick = showBoard;

// ---------- validation report ----------
const VERDICT_NAMES = { support: '假设成立', partial: '部分成立', reject: '假设不成立', unclear: '样本不足' };
async function openReport() {
  const id = current.id;
  $('#rpName').textContent = current.name;
  $('#rpHyp').textContent = current.validation?.hypothesis ? '要验证：' + current.validation.hypothesis : '要验证：' + (current.description || '');
  const { report, evidence: ev } = await api(`/api/projects/${id}/report`);
  if (current?.id !== id) return;
  renderReport(report, ev);
  api(`/api/projects/${id}/pretest`).then(({ pretest }) => { if (current?.id === id) renderPretest(pretest); }).catch(() => {});
  if (!$('#dlgReport').open) $('#dlgReport').showModal();
}
let lastReport = null;
function renderReport(report, ev) {
  const r = ev.reactions;
  $('#rpStats').innerHTML = [['访客', ev.visitors], ['👍 有用', r.up], ['🤔 一般', r.meh], ['👎 用不上', r.down]].map(([k, v]) => `<div><span class="muted small">${k}</span><b>${v}</b></div>`).join('');
  const qa = Object.entries(ev.answers || {});
  let html = '';
  if (report) {
    const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
    html += `<div class="rp-verdict"><h4><span class="verdict ${report.verdict}">${VERDICT_NAMES[report.verdict]}</span>${esc(report.summary)}</h4>
      <div class="muted small">可信度 ${esc(report.confidence)} · 基于 ${report.stats.feedback} 条反馈 · ${new Date(report.ts).toLocaleString()}</div>
      ${report.evidence.length ? `<div class="lbl">证据</div><ul>${li(report.evidence)}</ul>` : ''}${report.concerns.length ? `<div class="lbl">顾虑</div><ul>${li(report.concerns)}</ul>` : ''}${report.next.length ? `<div class="lbl">下一步</div><ul>${li(report.next)}</ul>` : ''}</div>`;
  }
  if (qa.length) html += `<div class="rp-qa">${qa.map(([q, as]) => `<p><b>${esc(q)}</b></p><ul>${as.slice(0, 8).map(a => `<li>${esc(a)}</li>`).join('')}</ul>`).join('')}</div>`;
  if (!report && !ev.feedback) html += `<div class="muted small">还没有反馈。点「分享给目标用户」生成链接发出去，试用者在页面右下角就能表态、回答验证问题。发出去之前，可以先点「AI 模拟试用」让模拟用户挑一遍毛病。</div>`;
  $('#rpBody').innerHTML = html;
  $('#rpGen').disabled = !ev.feedback; $('#rpInfo').textContent = '';
  lastReport = report; $('#rpIterate').hidden = !report || !(report.next.length || report.concerns.length);
}
$('#btnReport').onclick = openReport;
$('#rpClose').onclick = () => $('#dlgReport').close();
$('#rpIterate').onclick = () => {
  const r = lastReport; if (!r) return;
  const msg = `根据试用验证的结论改出第二版 Demo，用来做下一轮验证。\n结论：${VERDICT_NAMES[r.verdict]}——${r.summary}\n${r.concerns.length ? `试用者的顾虑：\n${r.concerns.map(x => '- ' + x).join('\n')}\n` : ''}建议的下一步：\n${r.next.map(x => '- ' + x).join('\n')}\n请只做能在 Demo 里体现、帮助下一轮验证的改动（不能在 Demo 里验证的，如线下调研，写进总结里提醒我）；保持验证版的轻量，改完在电脑和手机上各看一次。`;
  $('#dlgReport').close();
  isBusy(current) ? enqueue(msg) : send(msg, { budget: FIRST_BUILD_BUDGET });
};
$('#rpShare').onclick = () => { $('#dlgReport').close(); openShare(); };
$('#rpGen').onclick = async () => {
  const b = $('#rpGen'); b.disabled = true; $('#rpInfo').textContent = 'AI 正在根据证据写结论…';
  try { const { report, evidence: ev } = await api(`/api/projects/${current.id}/report`, { method: 'POST' }); renderReport(report, ev); loadProjects(); }
  catch (e) { $('#rpInfo').textContent = '✗ ' + e.message; b.disabled = false; }
};

/** After a build turn of an idea that hasn't been tried by anyone yet (no pre-test, no share): suggest the next step. */
function nudgePretest(key) { // key = view key "<projectId>:<session>"
  const pid = String(key).split(':')[0], p = projects.find(x => x.id === pid), v = p?.validation;
  if (!p?.plan || !v || v.pretest || v.shares || v.feedback) return;
  const d = addSys(key, '下一步：发给真人之前，可以先让 4 位模拟用户试一遍，挑出看不懂、不可信的地方（约 1 分钟）。');
  const b = document.createElement('button'); b.className = 'ghost small'; b.textContent = '🧪 AI 模拟试用';
  b.style.marginLeft = '8px';
  b.onclick = async () => { b.remove(); if (current?.id !== pid) return; await openReport(); $('#rpPretest').click(); };
  d.appendChild(b);
}

// AI pre-test: simulated target users try the demo before real people do (shown apart from the real evidence)
const REACT_ICON = { up: '👍', meh: '🤔', down: '👎' };
let lastPretest = null;
function renderPretest(t) {
  lastPretest = t;
  if (!t) { $('#rpPre').innerHTML = ''; return; }
  const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
  $('#rpPre').innerHTML = `<div class="row between"><b>AI 模拟试用</b><span class="muted small">模拟，不算真实证据 · ${new Date(t.ts).toLocaleString()}</span></div>
    ${t.walked?.length ? `<div class="muted small">先自动走了一遍：${t.walked.map(w => `${w.ok ? '✓' : '⚠'} ${esc(w.goal)}`).join('　')}</div>` : ''}
    <div class="pre-grid">${t.personas.map(p => `<div class="pre-p"><div class="pre-h"><span>${REACT_ICON[p.reaction]}</span><b>${esc(p.name)}</b></div>
      <div class="muted small">${esc(p.attitude)}</div><div>${esc(p.firstLook)}</div>
      ${p.answers.length ? `<ul class="small">${p.answers.map(a => `<li title="${esc(a.q)}">${esc(a.a)}</li>`).join('')}</ul>` : ''}
      ${p.quote ? `<div class="pre-q">“${esc(p.quote)}”</div>` : ''}</div>`).join('')}</div>
    ${t.confusions.length ? `<div class="lbl">容易看不懂</div><ul>${li(t.confusions)}</ul>` : ''}
    ${t.fixes.length ? `<div class="lbl">分享前建议先改</div><ul>${li(t.fixes)}</ul><div class="row end"><button id="rpPreFix" class="ghost">让 AI 先改这些</button></div>` : ''}`;
  const fix = $('#rpPreFix');
  if (fix) fix.onclick = () => {
    const msg = `分享给真人试用前，先按 AI 模拟试用发现的问题改一下 Demo（模拟用户的意见只作参考，你判断不合理的可以不改，说明原因）。\n${t.confusions.length ? `容易看不懂的地方：\n${t.confusions.map(x => '- ' + x).join('\n')}\n` : ''}建议先改：\n${t.fixes.map(x => '- ' + x).join('\n')}\n保持验证版的轻量，只改这些；需要新页面的，只做能演示那一下的最小版本；改完在电脑和手机上各看一次。`;
    $('#dlgReport').close();
    isBusy(current) ? enqueue(msg) : send(msg, { budget: FIRST_BUILD_BUDGET });
  };
}
$('#rpPretest').onclick = async () => {
  const id = current.id, b = $('#rpPretest'); b.disabled = true;
  try {
    if (current.status !== 'running') throw new Error('项目没在运行：先启动再试');
    $('#rpInfo').textContent = '正在打开各页面…';
    const { pages } = await api(`/api/projects/${id}/pretest`);
    const snaps = await PageBot.capture(id, pages);
    $('#rpInfo').textContent = '规划并走一遍核心流程…';
    let walks = [];
    try {
      const plan = await api(`/api/projects/${id}/pretest/walks`, { method: 'POST', body: { pages: snaps } });
      walks = await PageBot.walk(id, plan.walks || [], (goal, text) => api(`/api/projects/${id}/pretest/continue`, { method: 'POST', body: { goal, text } }).then(r => r.actions || []));
    } catch {} // without walkthroughs the pre-test falls back to the agent's own page_act runs
    $('#rpInfo').textContent = `4 位模拟用户正在试用 ${snaps.length} 个页面…`;
    const { pretest } = await api(`/api/projects/${id}/pretest`, { method: 'POST', body: { pages: snaps, walks } });
    loadProjects();
    if (current?.id === id) { renderPretest(pretest); $('#rpInfo').textContent = ''; $('#rpPre').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (e) { $('#rpInfo').textContent = '✗ ' + e.message; }
  finally { b.disabled = false; }
};

// ---------- phone layout: bottom tabs switch between projects / chat / preview ----------
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function setTab(t) {
  document.body.classList.remove('m-projects', 'm-chat', 'm-preview');
  document.body.classList.add('m-' + t);
  if (t === 'projects') { document.body.classList.add('view-board'); renderBoard(); }
  if (t === 'chat') { const box = $('#messages'); box.scrollTop = box.scrollHeight; }
}
setTab('projects');
if (isPhone()) $('#input').placeholder = '告诉 AI 你想怎么改…（处理中可直接插话）';
for (const b of document.querySelectorAll('#mtabs button')) b.onclick = () => setTab(b.dataset.t);

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
  showBoard(); // home = idea board
  renderHeader();
  if (!settings.hasKey) toggleSettings(true);
  setInterval(loadProjects, 5000);
})();
