const $ = s => document.querySelector(s);
let projects = [], current = null, settings = null;
// technical details (ports, tokens, start/stop, logs) are for developers; off by default
const setDev = on => { document.body.classList.toggle('dev', on); try { localStorage.setItem('sdDev', on ? '1' : ''); } catch {} };
setDev((() => { try { return localStorage.getItem('sdDev') === '1'; } catch { return false; } })());
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
    li.innerHTML = `<span class="dot ${p.status}"></span><span class="n">${esc(p.name)}</span>${isBusy(p) ? '<span class="thinking small">⋯</span>' : ''}<span class="muted small port">:${p.port}</span>`;
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
  document.body.classList.remove('view-board', 'view-new');
  if (location.hash !== '#/p/' + id) location.hash = '/p/' + id; // own address: bookmarkable, browser back returns to the board
  if (current?.id === id) { if (isPhone()) setTab('chat'); return; }
  current = projects.find(p => p.id === id) || null;
  if (isPhone() && current) setTab('chat'); // picking a project on a phone goes straight to its conversation
  await loadProjects();
  if (!current) return;
  await PageBot.init();
  const live = current.status === 'running' || current.status === 'starting';
  current.hasUi && live ? PageBot.show($('#frame'), current.id) : PageBot.clear($('#frame'));
  $('#previewUrl').textContent = `/p/${current.id}/${PageBot.isolated() ? '' : '（⚠ 同源预览）'}`;
  $('#previewUrl').title = PageBot.isolated() ? 'Demo 在独立的源里运行，碰不到 SuperDemo' : 'Demo 端口从这个浏览器访问不到，预览退回到和 SuperDemo 同源：请在「模型设置」里填「Demo 地址」';
  $('#btnOpen').href = PageBot.previewUrl(current.id);
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
  $('#fbBadge').hidden = !fbn; $('#fbBadge').textContent = fbn; $('#btnFeedback').title = fbn ? `${fbn} 条反馈还没处理` : '别人通过分享链接留下的意见';
  $('#btnRestart').disabled = !live;
  $('#btnToggle').textContent = live ? '■ 停止' : '▶ 启动';
  $('#btnToggle').title = live ? '停止运行这个 Demo（不删除，随时可以再启动）' : '启动这个 Demo';
  $('#btnToggle').hidden = !has;
  $('#btnToggle').classList.toggle('start', has && !live);
  document.body.classList.toggle('no-preview', has && !live);
  if (has && !live && $('#frame').src !== 'about:blank') PageBot.clear($('#frame'));
  if (live && current.hasUi && $('#frame').src === 'about:blank') PageBot.show($('#frame'), current.id);
  $('#btnClear').disabled = !has || busy;
  updateSketchOverlay(busy);
  // busy: empty input -> stop button; typed text -> interject (queued into the running turn)
  const sendBtn = $('#send'), typed = !!$('#input').value.trim(), isStopping = busy && stopping.has(current.id);
  sendBtn.disabled = !has || isStopping;
  sendBtn.textContent = !busy ? '发送' : isStopping ? '停止中…' : typed ? '↩ 插话' : '■ 停止';
  sendBtn.classList.toggle('stop', busy && !typed);
  sendBtn.title = !busy ? '' : typed ? '插话：当前步骤完成后 AI 会看到这条消息 (Enter)' : '停止本轮处理 (Esc)';
  $('#queueBtn').hidden = !(busy && typed && !isStopping);
  $('#pName').textContent = current ? current.name : '选择或新建一个项目';
  $('#mBusy').hidden = !busy;
  const STATUS_CN = { running: '运行中', starting: '启动中', stopped: '已停止', crashed: '出错了，正在重试' };
  $('#pMeta').textContent = !current ? '' : document.body.classList.contains('dev') ? `${current.typeLabel} · ${current.status} · 端口 ${current.port} · id ${current.id}`
    : [STATUS_CN[current.status] || current.status, isBusy(current) ? 'AI 正在处理' : ''].filter(Boolean).join(' · ');
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
function addMsg(pid, role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; if (role === 'assistant' && text) d.innerHTML = md(text); else d.textContent = text; return append(pid, d, role === 'user'); }

/** Small, safe Markdown for the assistant's answers: headings, bold, inline code, code blocks, lists, quotes, http links. */
function md(src) {
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  const out = []; let list = null, code = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(src).split('\n')) {
    if (code !== null) { if (/^```/.test(line)) { out.push(`<pre><code>${esc(code)}</code></pre>`); code = null; } else code += (code ? '\n' : '') + line; continue; }
    if (/^```/.test(line)) { close(); code = ''; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<div class="mh mh${m[1].length}">${inline(m[2])}</div>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      const t = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== t) { close(); out.push(`<${t}>`); list = t; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    close();
    if ((m = line.match(/^>\s?(.*)/))) { out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    out.push(line.trim() ? `<p>${inline(line)}</p>` : '');
  }
  close(); if (code !== null) out.push(`<pre><code>${esc(code)}</code></pre>`);
  return out.join('');
}
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
  if (l?.msg) { l.msg.innerHTML = md(content); l.msg.classList.remove('live'); l.msg = null; }
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
    case 'done': finishText(pid, ev.content); if (ev.stopped) addSys(pid, '■ 已停止'); if (sameProject(pid)) reloadFrame(); lastDone.set(String(pid).split(':')[0], ev); if (!ev.stopped) nudgePretest(pid); break;
    case 'error': addMsg(pid, 'error', ev.message); break;
  }
}

// while the agent is operating the preview, an automatic reload would wipe what it is doing
const pageBotBusy = new Set();
function reloadFrame() { const f = $('#frame'); if (current?.hasUi && !pageBotBusy.size) PageBot.show(f, current.id, f.dataset.project === current.id ? (f.dataset.path || '').replace(/^\//, '') : ''); }
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
  $('#stPublic').value = settings.publicUrl || '';
  $('#stDemoUrl').value = settings.demoUrl || ''; $('#stDemoPort').textContent = settings.demoPort || '';
  $('#stNotify').value = settings.notifyWebhook || '';
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
  if (show) { $('#stResult').textContent = ''; $('#stpResult').textContent = ''; $('#stDev').checked = document.body.classList.contains('dev'); if (!dlg.open) dlg.showModal(); }
  else if (dlg.open) dlg.close();
}
$('#stNotifyTest').onclick = async () => { const r = $('#stResult'); r.textContent = '发送中…'; try { await api('/api/settings/notify-test', { method: 'POST', body: { url: $('#stNotify').value } }); r.textContent = '✓ 测试消息已发出，去群里看看'; } catch (e) { r.textContent = '✗ ' + e.message; } };
$('#stDev').onchange = e => { setDev(e.target.checked); renderHeader(); };
async function saveSettings() {
  const body = { baseUrl: $('#stBase').value, model: $('#stModel').value, temperature: $('#stTemp').value, maxIterations: $('#stIter').value, contextWindow: $('#stCtx').value, stream: $('#stStream').checked, vision: $('#stVision').value, publicUrl: $('#stPublic').value, demoUrl: $('#stDemoUrl').value, notifyWebhook: $('#stNotify').value, projectLlm: collectProjectLlm() };
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
// step 1 is a "new conversation" view in the main area; step 2 (confirm the plan) is a dialog over it
const npStep = n => { if (n === 1) { $('#dlgNew').close(); $('#npDesc').focus(); } else if (!$('#dlgNew').open) $('#dlgNew').showModal(); };
let npMode = 'plan', npFrom = null;
const NP_HINTS = { plan: '约 10 秒出方案，先看方案和草图再决定做不做', auto: '全自动做完：方案 → 草图 → 制作 → 模拟用户挑毛病 → 修改，约 12–18 分钟，期间保持页面打开', skip: '不出方案，按你写的直接开始制作（约 8–10 分钟）' };
function setNpMode(m) {
  npMode = m;
  for (const b of document.querySelectorAll('.ni-mode')) { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('#npHint').textContent = NP_HINTS[m];
}
for (const b of document.querySelectorAll('.ni-mode')) b.onclick = () => { setNpMode(b.dataset.mode); $('#npDesc').focus(); };
const npGrow = () => { const t = $('#npDesc'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 320) + 'px'; };
$('#npDesc').addEventListener('input', npGrow);
$('#npDesc').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $('#npGo').click(); }
});
$('#npGo').onclick = () => { if (!$('#npGo').disabled) ({ plan: npPlan, auto: npAuto, skip: npSkip })[npMode](); };
const npBusy = on => ['#npGo', '#npPlan', '#npAuto', '#npSkip'].forEach(s => $(s).disabled = on);
function closeNewIdea() {
  if (!document.body.classList.contains('view-new')) return;
  document.body.classList.remove('view-new');
  if (npFrom && projects.some(p => p.id === npFrom)) select(npFrom); else showBoard();
}
async function openNewIdea(prefill = '') {
  // nothing works without a model: send a first-time user to the settings instead of a dialog that will fail
  if (settings && !(settings.hasKey && settings.baseUrl && settings.model)) { toggleSettings(true); alert('先配置 AI 模型：填写 Base URL、Model 和 API Key（在左下角 ⚙ 也能打开），保存后再来写想法。'); return; }
  const [types, sks] = await Promise.all([api('/api/project-types'), api('/api/skeletons')]);
  skeletons = sks;
  const sel = $('#npType'); sel.innerHTML = '';
  for (const t of types) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; o.disabled = !t.available; sel.appendChild(o); }
  $('#npType').onchange();
  if (!document.body.classList.contains('view-new')) npFrom = document.body.classList.contains('view-board') ? null : current?.id || null;
  document.body.classList.remove('view-board'); document.body.classList.add('view-new');
  $('#npDesc').value = prefill; $('#npStatus').textContent = prefill ? '可以直接改成你自己的想法，然后按 Enter 开始' : '';
  renderExampleChips(); planCreated = false; setNpMode(npMode);
  npStep(1); npGrow();
  if (!prefill) offerDraft();
}
$('#newProject').onclick = () => openNewIdea();
$('#npCancel').onclick = closeNewIdea;
addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('view-new') && !document.querySelector('dialog[open]')) closeNewIdea(); });
$('#npType').onchange = () => { const web = !$('#npType').value || $('#npType').value === 'web'; $('#npPlan').hidden = $('#npAuto').hidden = !web; $('#npSkip').textContent = web ? '跳过方案直接做' : '创建并开始'; if (!web) setNpMode('skip'); };

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
  $('#ppHyp').value = plan.hypothesis || ''; $('#ppCriteria').value = plan.criteria || '';
  $('#ppSample').value = plan.sampleData || ''; $('#ppNotes').value = ''; $('#ppStatus').textContent = '';
  renderDesigns(plan.designs || [], plan.design || 0);
  npStep(2);
  $('#dlgNew').scrollTop = 0;
}

// a generated plan (and its sketches) took a minute and some money: closing the dialog keeps it as a draft
const DRAFT_KEY = 'sdPlanDraft';
let planCreated = false;
$('#dlgNew').addEventListener('close', () => {
  if (planCreated || !lastPlan) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), desc: planDesc, plan: { ...readPlan(), sketches: lastPlan.sketches || [] } })); } catch {}
});
function planDraft() { try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return d && Date.now() - d.ts < 7 * 86400e3 ? d : null; } catch { return null; } }
function offerDraft() {
  const d = planDraft(); if (!d) return;
  const st = $('#npStatus'); st.innerHTML = `有一份上次没做完的方案「${esc(d.plan.name || d.desc.slice(0, 20))}」 `;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost small'; b.textContent = '恢复它';
  b.onclick = () => { planDesc = d.desc; $('#npDesc').value = d.desc; npGrow(); showPlan(d.plan); };
  st.appendChild(b);
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

// while the first build runs, the preview shows the chosen sketch (the target) instead of the half-built page
const sketchHidden = new Set();
let sketchShownFor = null;
async function updateSketchOverlay(busy) {
  const id = current?.id, show = !!id && busy && current.validation?.sketchPending && !sketchHidden.has(id);
  $('#sketchOverlay').hidden = !show;
  if (!show) { sketchShownFor = null; return; }
  if (sketchShownFor === id) return;
  sketchShownFor = id;
  try { const html = await fetch(`/api/projects/${id}/sketch`).then(r => (r.ok ? r.text() : '')); if (current?.id === id && html) $('#soFrame').srcdoc = await sketchDoc(html); } catch {}
}
$('#soHide').onclick = () => { sketchHidden.add(current.id); $('#sketchOverlay').hidden = true; };

// ---------- design sketches: a static mock of the core screen per direction, to compare before building ----------
let sdCss = null;
async function sketchDoc(html) {
  sdCss ??= await fetch('/_sd/sd.css').then(r => r.text()).catch(() => '');
  return html.replace(/<link[^>]*_sd\/sd\.css[^>]*>/i, () => `<style>${sdCss}</style>`);
}
async function showSketchThumb(card, sk) { // sk = { html, device }
  const { html, device } = sk, mobile = device === 'mobile';
  card.querySelector('.pp-sk')?.remove();
  const wrap = document.createElement('div'); wrap.className = 'pp-sk'; wrap.title = '点击放大';
  const f = document.createElement('iframe'); f.setAttribute('sandbox', ''); f.tabIndex = -1; f.srcdoc = await sketchDoc(html);
  wrap.appendChild(f); wrap.insertAdjacentHTML('beforeend', '<span class="zoom">🔍 放大</span>'); card.insertBefore(wrap, card.firstChild);
  if (mobile) f.classList.add('m');
  // desktop: 1280 wide fills the card; phone: 390×844 scaled to the card height, centred
  const fit = () => { const k = mobile ? wrap.clientHeight / 844 : wrap.clientWidth / 1280; f.style.transform = `scale(${k})`; f.style.left = mobile ? `${(wrap.clientWidth - 390 * k) / 2}px` : '0'; };
  fit(); new ResizeObserver(fit).observe(wrap);
  wrap.onclick = async e => { e.stopPropagation(); card.click(); $('#skFrame').classList.toggle('m', mobile); $('#skFrame').srcdoc = await sketchDoc(html); $('#skTitle').textContent = card.querySelector('b').textContent; $('#dlgSketch').showModal(); };
}
$('#skClose').onclick = () => $('#dlgSketch').close();
$('#skUse').onclick = () => $('#dlgSketch').close(); // the card was already selected when the sketch was opened
$('#ppSketch').onclick = async () => {
  const plan = lastPlan; if (!plan?.designs?.length) return;
  const btn = $('#ppSketch'); btn.disabled = true;
  const cards = [...$('#ppDesigns').children], current = readPlan();
  plan.sketches ||= [];
  $('#ppStatus').textContent = `正在为 ${cards.length} 个方向画草图（约 1 分钟）…`;
  let fail = 0;
  await Promise.all(cards.map(async (card, i) => {
    card.querySelector('.pp-sk')?.remove();
    card.insertAdjacentHTML('afterbegin', '<div class="pp-sk loading">绘制中…（约 40 秒）</div>');
    try {
      const sk = await api('/api/projects/sketch', { method: 'POST', body: { plan: { ...current, design: i }, index: i, description: planDesc } });
      if (lastPlan !== plan) return;
      plan.sketches[i] = sk; await showSketchThumb(card, sk);
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
    hypothesis: $('#ppHyp').value.trim(), criteria: $('#ppCriteria').value.trim(), signals: ppValues('signals'),
  };
}
async function genPlan(statusEl) {
  const btns = ['#npGo', '#npPlan', '#npAuto', '#npSkip', '#ppRegen', '#ppOk'].map(s => $(s)); btns.forEach(b => b.disabled = true);
  statusEl.textContent = 'AI 正在出方案（约 10–30 秒）…';
  try { const { plan } = await api('/api/projects/plan', { method: 'POST', body: { description: planDesc } }); showPlan(plan); }
  catch (e) { statusEl.textContent = '✗ ' + e.message; }
  finally { btns.forEach(b => b.disabled = false); }
}
function npPlan() {
  planDesc = $('#npDesc').value.trim();
  if (!planDesc) { $('#npStatus').textContent = '请先写一句你想做什么'; $('#npDesc').focus(); return; }
  genPlan($('#npStatus'));
}
$('#ppRegen').onclick = () => genPlan($('#ppStatus'));

// ---------- autopilot: one sentence -> plan -> sketch -> build -> simulated users -> one round of fixes ----------
const lastDone = new Map(), autopiloting = new Set();
const FIX_BUDGET = 30; // pre-test fixes are small by design; an out-of-steps turn still ends with a summary
async function npAuto() {
  const description = $('#npDesc').value.trim(), st = $('#npStatus');
  if (!description) { st.textContent = '请先写一句你想做什么'; $('#npDesc').focus(); return; }
  npBusy(true);
  let p;
  try {
    st.textContent = '1/5 出方案…';
    const { plan } = await api('/api/projects/plan', { method: 'POST', body: { description } });
    let sk = null;
    if (plan.designs?.length) {
      st.textContent = `2/5 按推荐方向「${plan.designs[0].name}」画草图…`;
      try { sk = await api('/api/projects/sketch', { method: 'POST', body: { plan, index: 0, description } }); } catch {} // a sketch is a bonus
    }
    p = await api('/api/projects', { method: 'POST', body: { description, type: 'web', name: plan.name, plan, sketch: sk?.html || '', sketchDevice: sk?.device || '' } });
    $('#dlgNew').close();
    await loadProjects(); await select(p.id);
  } catch (e) { st.textContent = '✗ ' + e.message; return; }
  finally { npBusy(false); }
  autopiloting.add(p.id);
  const say = t => { if (current?.id === p.id) addSys(viewKey(), '⚡ 一键到底 · ' + t); };
  const stopped = () => current?.id !== p.id || lastDone.get(p.id)?.stopped;
  // send() returns when this tab's stream ends; if the stream dropped, the run may still be going on the server
  const run = async (msg, budget) => {
    lastDone.delete(p.id);
    await send(msg, { budget });
    for (let k = 0; k < 400; k++) { await loadProjects(); if (!projects.find(x => x.id === p.id)?.busy) break; await new Promise(r => setTimeout(r, 3000)); }
  };
  try {
    say('3/5 按方案和草图制作（约 6–8 分钟）');
    await run(p.firstMessage, FIRST_BUILD_BUDGET);
    if (stopped()) return say('已中断：切换了项目或手动停止，后面的步骤可以在「📊 验证」里手动做');
    say('4/5 AI 模拟试用：先走一遍核心流程，再让 4 位模拟用户挑毛病');
    const t = await runPretest(p.id, () => {});
    if (stopped()) return;
    const tally = t.personas.reduce((a, x) => (a[x.reaction]++, a), { up: 0, meh: 0, down: 0 });
    say(`模拟试用结果：👍${tally.up} 🤔${tally.meh} 👎${tally.down}${t.fixes.length ? '，按建议改一版' : '，没有必须改的'}`);
    if (t.fixes.length) {
      say('5/5 按模拟用户的意见修改');
      await run(pretestFixMessage(t), FIX_BUDGET);
      if (stopped()) return;
    }
    const d = addSys(viewKey(), '✅ 一键到底完成：Demo 做好了，也替你挑过一轮毛病。下一步把它发给真实的目标用户，收集他们的看法。');
    const b = document.createElement('button'); b.className = 'ghost small'; b.style.marginLeft = '8px'; b.textContent = '🔗 生成分享链接';
    b.onclick = () => openShare(); d.appendChild(b);
  } catch (e) { say('出错了：' + e.message + '（可以在「📊 验证」里手动继续）'); }
  finally { autopiloting.delete(p.id); }
}
$('#ppBack').onclick = () => npStep(1);
$('#ppClose').onclick = () => $('#dlgNew').close();
async function createAndStart(body, statusEl, btn) {
  btn.disabled = true; statusEl.textContent = '正在创建项目…';
  try {
    const p = await api('/api/projects', { method: 'POST', body });
    planCreated = true; try { localStorage.removeItem(DRAFT_KEY); } catch {}
    $('#dlgNew').close();
    await loadProjects(); await select(p.id);
    send(p.firstMessage, { budget: FIRST_BUILD_BUDGET });
  } catch (e) { statusEl.textContent = '✗ ' + e.message; }
  finally { btn.disabled = false; }
}
$('#ppOk').onclick = () => createAndStart({ description: planDesc, type: 'web', name: $('#ppName').value.trim(), plan: readPlan(), sketch: lastPlan?.sketches?.[planDesign]?.html || '', sketchDevice: lastPlan?.sketches?.[planDesign]?.device || '' }, $('#ppStatus'), $('#ppOk'));
function npSkip() {
  const description = $('#npDesc').value.trim();
  if (!description) { $('#npStatus').textContent = '请先写一句你想做什么'; $('#npDesc').focus(); return; }
  createAndStart({ description, type: $('#npType').value }, $('#npStatus'), $('#npGo'));
}

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
  current = null; currentSession = null; PageBot.clear($('#frame')); $('#messages').innerHTML = ''; $('#usage').hidden = true; $('#sessionBar').hidden = true; $('#queueBar').hidden = true;
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
// share links: the demo origin's public address; else the shell's public address (reachable from outside, but same
// origin as the shell); else the demo origin as seen from here; else this origin
const shareUrl = token => `${settings?.demoUrl || (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) && settings?.publicUrl ? settings.publicUrl : PageBot.origin()) || settings?.publicUrl || location.origin}/s/${token}/`;
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
  const h = location.hostname, pub = settings?.publicUrl;
  const local = !pub && /^(localhost|127\.|\[::1\])/.test(h);
  const lan = !pub && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^.]+\.local$)/.test(h);
  $('#shHint').textContent = local ? '⚠ 你正通过本机地址访问：生成的链接只在这台电脑上能打开，发给别人是打不开的。请部署到服务器 / NAS，从那里打开 SuperDemo 再分享。'
    : lan ? '⚠ 你正通过局域网地址访问：链接只有同一个 Wi-Fi / 内网里的人能打开。要发给外面的人，请在「模型设置」里填「分享链接的公网地址」（域名或内网穿透地址）。'
    : pub ? `分享链接使用公网地址：${pub}` : '';
  $('#shHint').classList.toggle('warn-box', local || lan);
  const list = await api(`/api/projects/${id}/shares`);
  if (current?.id !== id) return;
  showInvite(list.find(x => x.active)?.token);
  const ul = $('#shList'); ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li class="muted small">还没有分享链接。</li>';
  for (const s of list) {
    const li = document.createElement('li'); li.className = s.active ? '' : 'revoked';
    const state = s.revoked ? '已关闭' : !s.active ? '已过期' : s.expiresAt ? `有效至 ${new Date(s.expiresAt).toLocaleString()}` : '永久有效';
    li.innerHTML = `<div class="vmain"><div class="surl"></div><div class="muted small"></div><div class="sstats" hidden></div></div><button class="ghost stat">统计</button>${s.active ? `<label class="check small" title="访客页面右下角显示「💬 说说看法」按钮，可以表态、回答验证问题、留言"><input type="checkbox" class="fb"${s.feedback !== false ? ' checked' : ''}> 允许访客留言</label><a class="ghost btn small open" target="_blank" rel="noopener" title="用访客的视角打开（含导览卡和说说看法按钮）">打开看看</a><button class="ghost copy">复制</button><button class="ghost danger off" title="让这个链接立即失效">停用链接</button>` : ''}`;
    li.querySelector('.stat').onclick = async () => {
      const box = li.querySelector('.sstats');
      if (!box.hidden) { box.hidden = true; return; }
      const st = await api(`/api/projects/${id}/shares/${s.token}/stats`);
      const max = Math.max(1, ...st.days.map(d => d.views));
      box.innerHTML = `<span><b>${st.visitors}</b> 位访客 · <b>${st.views}</b> 次打开${st.actors ? ` · <b>${st.actors}</b> 人动手操作过` : ''}</span><span class="sbars" title="近 14 天每日打开次数">${st.days.map(d => `<i style="height:${Math.round(d.views / max * 100)}%" title="${d.date}：${d.views} 次 / ${d.visitors} 人"></i>`).join('')}</span>${st.pages.length ? `<span>常看页面：${st.pages.slice(0, 3).map(p => `${esc(p.page)} ×${p.views}`).join('，')}</span>` : ''}`;
      box.hidden = false;
    };
    if (s.active) li.querySelector('.fb').onchange = e => api(`/api/projects/${id}/shares/${s.token}`, { method: 'PATCH', body: { feedback: e.target.checked } });
    li.querySelector('.surl').textContent = shareUrl(s.token);
    li.querySelector('.small').textContent = [s.label, state, `打开 ${s.views || 0} 次`, s.lastViewAt ? `最近 ${new Date(s.lastViewAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
    if (s.active) {
      if (li.querySelector('.open')) li.querySelector('.open').href = `${settings?.demoUrl || PageBot.origin() || ''}/s/${s.token}/?_sdself=${current.previewKey}`; // the owner's own look is not a visit
      li.querySelector('.copy').onclick = async e => { e.target.textContent = await copyText(shareUrl(s.token)) ? '已复制' : '复制失败'; };
      li.querySelector('.off').onclick = async () => { if (!confirm('停用后这个链接立即失效，拿到链接的人将打不开，确定？')) return; await api(`/api/projects/${id}/shares/${s.token}`, { method: 'DELETE' }); openShare(); };
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
    $('#shHint').textContent = (ok ? '✓ 新链接已复制到剪贴板' : '链接已生成，请手动复制') + (s.protectedData ? '。访客会改动 Demo 里的数据，已把现在的数据存为「演示数据」，每天凌晨 4 点自动恢复（可在下方「演示数据」里修改）' : '');
  } catch (e) { alert('生成失败：' + e.message); }
  finally { btn.disabled = false; }
};

// ---------- header "more" menu ----------
$('#btnMore').onclick = e => { e.stopPropagation(); $('#moreMenu').hidden = !$('#moreMenu').hidden; };
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#moreMenu').hidden) $('#moreMenu').hidden = true; });
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
  if (!feedback.length) ul.innerHTML = '<li class="muted small">还没有反馈。生成分享链接发给别人试用，他们点页面右下角「💬 说说看法」就能留言。</li>';
  const ST = { new: '未处理', sent: '已交给 AI', done: '已处理' };
  for (const f of feedback) {
    const li = document.createElement('li'); li.className = 'st-' + f.status;
    li.innerHTML = `<input type="checkbox" data-id="${esc(f.id)}"><div class="vmain"><div class="fbtext"></div><div class="muted small"></div></div>`;
    const RX = { up: '👍 有用', meh: '🤔 一般', down: '👎 用不上' };
    const suspicious = /(run_command|\.env|api[_ -]?key|环境变量|密钥|cat\s+\/|rm\s+-rf|忽略(之前|以上)的?(指令|要求)|ignore (all|previous))/i.test([f.text, ...(f.answers || []).map(a => a.a)].join(' '));
    li.querySelector('.fbtext').textContent = [f.reaction && RX[f.reaction], f.text, ...(f.answers || []).map(a => `（${a.q} → ${a.a}）`)].filter(Boolean).join('  ');
    if (suspicious) li.querySelector('.fbtext').insertAdjacentHTML('afterbegin', '<span class="tag-sus" title="内容像是在让 AI 执行命令或读取密钥：交给 AI 时会被忽略">⚠ 可疑</span> ');
    if (f.bug) li.querySelector('.fbtext').insertAdjacentHTML('afterbegin', '<span class="tag-bug" title="访客报告 Demo 有地方坏了：勾选后交给 AI 修">🐞 出错</span> ');
    li.querySelector('.small').textContent = [ST[f.status], new Date(f.ts).toLocaleString(), f.name, f.contact ? '📇 想内测：' + f.contact : '', f.page && f.page !== '/' ? '页面 ' + f.page : '', f.viewport && parseInt(f.viewport) < 600 ? '📱 手机' : '', f.share?.label ? '来自链接「' + f.share.label + '」' : ''].filter(Boolean).join(' · ');
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
// steps: one row each — what to do (text) + which page it opens (dropdown of the project's pages)
let tourPages = [{ page: '', title: '首页' }];
function tourRow(st = { text: '', page: '' }) {
  const row = document.createElement('div'); row.className = 'tour-row';
  const opts = [...tourPages, ...(st.page && !tourPages.some(p => p.page === st.page) ? [{ page: st.page, title: st.page }] : [])];
  row.innerHTML = `<input class="tt" maxlength="120" placeholder="如：在「库存总览」看哪些商品标红"><select class="tp">${opts.map(p => `<option value="${esc(p.page)}">${esc(p.page ? `${p.title}（${p.page}）` : `${p.title}（首页）`)}</option>`).join('')}</select><button type="button" class="ghost small" title="删掉这一步">✕</button>`;
  row.querySelector('.tt').value = st.text; row.querySelector('.tp').value = st.page || '';
  row.querySelector('button').onclick = () => row.remove();
  $('#tourSteps').appendChild(row);
}
function renderTour(t) {
  $('#tourTitle').value = t.title || ''; $('#tourIntro').value = t.intro || '';
  $('#tourSteps').innerHTML = ''; (t.steps?.length ? t.steps : [{ text: '', page: '' }]).forEach(tourRow);
  $('#tourOn').checked = !!t.enabled && !!t.steps?.length;
}
const readTour = () => ({ enabled: $('#tourOn').checked, title: $('#tourTitle').value, intro: $('#tourIntro').value,
  steps: [...$('#tourSteps').querySelectorAll('.tour-row')].map(r => ({ text: r.querySelector('.tt').value.trim(), page: r.querySelector('.tp').value })).filter(x => x.text) });
async function loadTour() {
  try { tourPages = await api(`/api/projects/${current.id}/pages`); } catch {}
  try { renderTour(await api(`/api/projects/${current.id}/tour`)); $('#tourInfo').textContent = ''; } catch {}
}
$('#tourAdd').onclick = () => tourRow();
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
const STAGES = [['building', '✍️', '制作中', '新想法在这里，AI 做好第一版就会移到下一栏'], ['ready', '📤', '待分享', 'Demo 做好了：点卡片 → 分享，发给目标用户试'],
  ['validating', '🧪', '验证中', '已分享，等试用者表态和回答验证问题'], ['concluded', '✅', '有结论', '证据够了就在「📊 验证」里生成结论']];
// example ideas: a newcomer sees what a "one-sentence idea" looks like and can start from one with a click
const EXAMPLES = [
  ['🏪', '门店', '连锁便利店店长每天盘点临期商品，系统提醒哪些该打折、该下架，AI 给促销建议'],
  ['🔧', '工厂', '工厂设备巡检：巡检员用手机扫设备码记录结果，发现故障一键报修，主管看维修进度'],
  ['🥬', '摊位', '菜市场摊主用手机随手记每天进货和卖出，收摊后看今天赚了多少、明天该少进什么'],
  ['🩺', '社区', '社区护士每周电话回访高血压患者，记录血压和用药，系统提醒谁该回访、谁控制不好'],
  ['🚗', '培训', '驾校教练每周放出练车时段，学员在手机上预约，练完教练打个评价'],
  ['🏠', '家装', '装修公司销售在客户家现场选材料、量面积，当场算出报价单发给客户'],
];
const useExample = text => openNewIdea(text);
function renderIntro() {
  const box = $('#boardIntro'), few = projects.length < 3;
  box.hidden = !few;
  if (!few) return;
  box.innerHTML = `<div class="bi-steps"><span><b>①</b> 写一句想法</span><span><b>②</b> AI 出方案、做 Demo，模拟用户先挑一遍毛病</span><span><b>③</b> 把链接发给目标用户，看他们动不动手，AI 帮你下结论</span></div>
    <div class="muted small">从一个例子开始（点一下，改成你自己的也行）：</div>
    <div class="bi-ex">${EXAMPLES.map(([i, tag, t], k) => `<button class="ex" data-k="${k}"><span class="i">${i}</span><span class="tag">${tag}</span><span class="t">${esc(t)}</span></button>`).join('')}</div>`;
  box.querySelectorAll('.ex').forEach(b => { b.onclick = () => useExample(EXAMPLES[+b.dataset.k][2]); });
}
function renderExampleChips() {
  $('#npExamples').innerHTML = '<span class="muted small">例子：</span>' + EXAMPLES.slice(0, 4).map(([i, tag], k) => `<button type="button" class="chip" data-k="${k}">${i} ${tag}</button>`).join('');
  $('#npExamples').querySelectorAll('.chip').forEach(b => { b.onclick = () => { $('#npDesc').value = EXAMPLES[+b.dataset.k][2]; $('#npDesc').focus(); }; });
}

function showBoard() { if (location.hash.startsWith('#/p/')) history.pushState(null, '', location.pathname); document.body.classList.remove('view-new'); document.body.classList.add('view-board'); if (isPhone()) setTab('projects'); renderBoard(); }
const boardOpen = new Set();
function renderBoard() {
  if (!document.body.classList.contains('view-board')) return;
  if (comparing) return;
  renderIntro();
  const cols = $('#boardCols'); cols.innerHTML = '';
  // phones stack the columns: most valuable (conclusions) first, long columns folded to 4 cards
  const phone = isPhone();
  for (const [stage, icon, title, hint] of phone ? [...STAGES].reverse() : STAGES) {
    const list = projects.filter(p => (p.validation?.stage || 'building') === stage);
    const col = document.createElement('div'); col.className = 'bcol';
    const open = !phone || boardOpen.has(stage);
    col.innerHTML = `<div class="bcol-head">${icon} <b>${title}</b><span class="n">${list.length}</span></div>`;
    if (!list.length) col.insertAdjacentHTML('beforeend', `<div class="bcol-empty">${hint}</div>`);
    list.forEach((p, k) => { if (k >= 4 && !open) return;
      const v = p.validation || {}, r = v.reactions || { up: 0, meh: 0, down: 0 }, total = r.up + r.meh + r.down;
      const card = document.createElement('div'); card.className = 'icard';
      card.innerHTML = `<div class="shot${v.thumb ? '' : ' none'}">${v.thumb ? '' : (p.validation?.stage === 'building' ? '制作中…' : '还没有截图')}</div><div class="body"><div class="name"><span class="dot ${p.status}"></span><span></span>${isBusy(p) ? '<span class="thinking small">⋯</span>' : ''}</div>
        <div class="hyp"></div><div class="sig">${total ? `<span class="rxbar" title="👍 ${r.up} · 🤔 ${r.meh} · 👎 ${r.down}"><i style="width:${r.up / total * 100}%;background:#3fb950"></i><i style="width:${r.meh / total * 100}%;background:#d29922"></i><i style="width:${r.down / total * 100}%;background:#e5534b"></i></span>` : ''}
        ${total ? `<span>👍${r.up} 🤔${r.meh} 👎${r.down}</span>` : ''}${!total && v.pretest ? `<span class="sim" title="AI 扮演的模拟用户的表态，不是真人反馈">AI 模拟（非真人）👍${v.pretest.up} 🤔${v.pretest.meh} 👎${v.pretest.down}</span>` : ''}${v.actors ? `<span title="动手操作过的访客">🛠 ${v.actors}</span>` : ''}${v.feedback ? `<span>💬 ${v.feedback}</span>` : ''}${v.verdict ? `<span class="verdict ${v.verdict}">${esc(v.verdictLabel)}</span>` : ''}</div></div>`;
      if (v.thumb) card.querySelector('.shot').style.backgroundImage = `url("/api/projects/${p.id}/shots/${v.thumb}")`;
      card.querySelector('.name span:nth-child(2)').textContent = p.name;
      card.querySelector('.hyp').textContent = v.hypothesis || p.description || '';
      card.onclick = () => select(p.id, true);
      col.appendChild(card);
    });
    if (phone && list.length > 4) {
      const more = document.createElement('button'); more.className = 'ghost bcol-more';
      more.textContent = open ? '收起' : `展开全部 ${list.length} 个`;
      more.onclick = () => { open ? boardOpen.delete(stage) : boardOpen.add(stage); renderBoard(); };
      col.appendChild(more);
    }
    cols.appendChild(col);
  }
}
$('#bdNew').onclick = () => $('#newProject').click();

// ---------- idea comparison: all ideas' evidence side by side ----------
let comparing = false;
const SIGNAL_CLS = { strong: 'support', mixed: 'partial', thin: 'unclear', weak: 'reject', none: 'unclear' };
const pct = v => `${Math.round(v * 100)}%`;
async function renderCompare(data) {
  const box = $('#boardCompare');
  const { ideas, advice } = data || await api('/api/ideas/compare');
  const byId = Object.fromEntries(ideas.map(m => [m.id, m]));
  const tried = ideas.filter(m => m.visitors || m.reacted || m.pretest).length;
  box.innerHTML = `<div class="cmp-advice">${advice ? `<div class="row between"><b>🤖 AI 建议</b><span class="muted small">${new Date(advice.ts).toLocaleString()}</span></div>
      <div>${esc(advice.summary)}</div>
      ${advice.focus && byId[advice.focus] ? `<div>最值得继续：<a href="#/p/${advice.focus}">${esc(byId[advice.focus].name)}</a></div>` : ''}
      ${advice.park.length ? `<div class="muted small">建议先放下：${advice.park.filter(id => byId[id]).map(id => esc(byId[id].name)).join('、')}</div>` : ''}
      ${advice.todo.length ? `<ul>${advice.todo.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}` : `<div class="muted small">下表按证据强弱排好了：行为（真动手、留联系方式）比点赞更可信，不到 5 人的结论不稳。也可以让 AI 综合看看。</div>`}
      <div class="row end"><span id="cmpInfo" class="muted small" style="flex:1"></span><button id="cmpAdvise" class="${advice ? 'ghost' : 'primary'}"${tried < 2 ? ' disabled title="至少 2 个想法有试用数据才好比较"' : ''}>🤖 AI 帮我比一比</button></div></div>
    <table class="cmp"><thead><tr><th>想法</th><th>信号</th><th title="打开过分享链接的人">访客</th><th title="在 Demo 里真的提交、保存过东西的人">真动手</th><th title="点了「有用」并留下联系方式的人">留联系方式</th><th>👍 占比</th><th>结论</th><th>下一步</th></tr></thead><tbody>
    ${ideas.map(m => `<tr data-id="${m.id}"><td><b>${esc(m.name)}</b>${m.round > 1 ? ` <span class="muted small">第 ${m.round} 轮</span>` : ''}<div class="muted small hyp">${esc(m.hypothesis)}</div></td>
      <td><span class="verdict ${SIGNAL_CLS[m.signal]}">${m.label}</span>${m.signal !== 'none' && m.signal !== 'thin' ? `<div class="scorebar"><i style="width:${Math.round(m.score * 100)}%"></i></div>` : ''}</td>
      <td>${m.visitors || (m.reacted ? `≥${m.reacted}` : '–')}</td><td>${m.actors ? `${m.actors} <span class="muted small">${pct(m.actRate)}</span>` : '–'}</td><td>${m.contacts || '–'}</td>
      <td>${m.reacted ? `${pct(m.upRate)} <span class="muted small">${m.up}/${m.reacted}</span>` : (m.pretest ? `<span class="sim" title="AI 模拟用户，非真人">模拟 👍${m.pretest.up}/${m.pretest.up + m.pretest.meh + m.pretest.down}</span>` : '–')}</td>
      <td>${m.verdict ? `<span class="verdict ${m.verdict}">${esc(m.verdictLabel)}</span>` : '–'}</td><td class="small">${esc(m.next)}</td></tr>`).join('')}</tbody></table>`;
  box.querySelectorAll('tr[data-id]').forEach(tr => { tr.onclick = () => select(tr.dataset.id); });
  $('#cmpAdvise').onclick = async () => {
    const b = $('#cmpAdvise'); b.disabled = true; $('#cmpInfo').textContent = 'AI 正在比较各个想法的证据…';
    try { renderCompare(await api('/api/ideas/advice', { method: 'POST' })); } catch (e) { $('#cmpInfo').textContent = '✗ ' + e.message; b.disabled = false; }
  };
}
function setComparing(on) {
  comparing = on;
  $('#boardCompare').hidden = !on; $('#boardCols').hidden = on; $('#bdCompare').textContent = on ? '▦ 看板视图' : '⚖ 对比想法';
  if (on) { $('#boardIntro').hidden = true; renderCompare().catch(e => { $('#boardCompare').textContent = '✗ ' + e.message; }); } else renderBoard();
}
$('#bdCompare').onclick = () => setComparing(!comparing);
$('#btnBoard').onclick = showBoard;
addEventListener('hashchange', () => { const m = location.hash.match(/^#\/p\/(\w+)/); if (m) { if (current?.id !== m[1] || document.body.classList.contains('view-board')) select(m[1]); } else showBoard(); });
addEventListener('popstate', () => { if (!location.hash) showBoard(); });
$('#bdSettings').onclick = () => $('#openSettings').click();
document.querySelector('.brand-text').style.cursor = 'pointer';
document.querySelector('.brand-text').onclick = showBoard;

// ---------- validation report ----------
const VERDICT_NAMES = { support: '假设成立', partial: '部分成立', reject: '假设不成立', unclear: '样本不足' };
async function openReport() {
  const id = current.id;
  $('#rpName').textContent = current.name;
  $('#rpHyp').textContent = current.validation?.hypothesis ? '要验证：' + current.validation.hypothesis : '要验证：' + (current.description || '');
  if (current.plan?.criteria) $('#rpHyp').textContent += '\n成立标准：' + current.plan.criteria;
  const { report, evidence: ev, round, previous } = await api(`/api/projects/${id}/report`);
  if (current?.id !== id) return;
  renderRound(round, previous);
  renderReport(report, ev);
  api(`/api/projects/${id}/pretest`).then(({ pretest }) => { if (current?.id === id) renderPretest(pretest); }).catch(() => {});
  if (!$('#dlgReport').open) $('#dlgReport').showModal();
}
let lastReport = null;
function renderRound(round, prev) {
  const box = $('#rpRound');
  if (!prev) { box.hidden = true; return; }
  const p = prev.stats || {}, r = p.reactions || {};
  box.hidden = false;
  box.innerHTML = `<b>第 ${round} 轮验证</b><span class="muted small">只统计改版之后的访问和反馈</span>
    <div class="small">上一轮${prev.verdict ? ` <span class="verdict ${prev.verdict}">${VERDICT_NAMES[prev.verdict]}</span>` : ''}：访客 ${p.visitors ?? 0} · 动手 ${p.actors ?? 0} · 留联系方式 ${p.contacts ?? 0} · 👍${r.up ?? 0} 🤔${r.meh ?? 0} 👎${r.down ?? 0}${prev.summary ? ` — ${esc(prev.summary)}` : ''}</div>`;
}
function renderReport(report, ev) {
  const r = ev.reactions;
  const secs = ev.medianMs != null ? Math.round(ev.medianMs / 1000) : null;
  const reactedN = r.up + r.meh + r.down;
  $('#rpStats').innerHTML = [['访客', ev.visitors >= reactedN ? ev.visitors : `≥${reactedN}`], ['真动手的人', ev.actors ?? 0, '在 Demo 里真的提交、保存过东西的访客'], ['留联系方式', ev.contacts ?? 0, '点了「有用」并留下微信/手机号、想上线后第一时间用上的人'], ['一般看多久', secs == null ? '–' : secs >= 100 ? `${Math.round(secs / 6) / 10}分` : `${secs}秒`], ['👍 有用', r.up], ['🤔 一般', r.meh], ['👎 用不上', r.down]]
    .map(([k, v, t]) => `<div${t ? ` title="${t}"` : ''}><span class="muted small">${k}</span><b>${v}</b></div>`).join('');
  const qa = Object.entries(ev.answers || {});
  let html = '';
  if (report) {
    const li = a => a.map(x => `<li>${esc(x)}</li>`).join('');
    html += `<div class="rp-verdict"><h4><span class="verdict ${report.verdict}">${VERDICT_NAMES[report.verdict]}</span>${esc(report.summary)}</h4>
      <div class="muted small">可信度 ${esc(report.confidence)} · 基于 ${report.stats.feedback} 条反馈 · ${new Date(report.ts).toLocaleString()}</div>
      ${report.evidence.length ? `<div class="lbl">证据</div><ul>${li(report.evidence)}</ul>` : ''}${report.concerns.length ? `<div class="lbl">顾虑</div><ul>${li(report.concerns)}</ul>` : ''}${report.next.length ? `<div class="lbl">下一步</div><ul>${li(report.next)}</ul>` : ''}</div>`;
  }
  if (ev.groups?.length > 1) html += `<div class="rp-groups"><div class="lbl">按分享链接（不同人群）</div><table><tr><th>链接</th><th>访客</th><th>动手</th><th>👍</th><th>🤔</th><th>👎</th></tr>${ev.groups.map(g => `<tr><td>${esc(g.label)}</td><td>${g.visitors}</td><td>${g.actors}</td><td>${g.reactions.up}</td><td>${g.reactions.meh}</td><td>${g.reactions.down}</td></tr>`).join('')}</table></div>`;
  if (qa.length) html += `<div class="rp-qa">${qa.map(([q, as]) => `<p><b>${esc(q)}</b></p><ul>${as.slice(0, 8).map(a => `<li>${esc(a)}</li>`).join('')}</ul>`).join('')}</div>`;
  if (!report && !ev.feedback) html += `<div class="muted small">还没有反馈。点「分享给目标用户」生成链接发出去，试用者在页面右下角就能表态、回答验证问题。发出去之前，可以先点「AI 模拟试用」让模拟用户挑一遍毛病。</div>`;
  $('#rpBody').innerHTML = html;
  $('#rpGen').disabled = !ev.feedback; $('#rpInfo').textContent = '';
  // the most useful next step is the primary button: no evidence yet -> share; evidence -> write the verdict
  $('#rpShare').className = ev.feedback ? 'ghost' : 'primary'; $('#rpGen').className = ev.feedback ? 'primary' : 'ghost';
  // how far the evidence is from a stable conclusion (≥ 5 people who reacted)
  const reacted = r.up + r.meh + r.down;
  if (ev.feedback && reacted < 5) $('#rpInfo').textContent = `已有 ${reacted} 人表态，再收集 ${5 - reacted} 人，结论会更可信`;
  if (ev.bugs?.length) $('#rpInfo').textContent = `🐞 有 ${ev.bugs.length} 位访客报告 Demo 出错：先在「反馈」里勾选交给 AI 修好，不然大家评价的是 bug，不是想法`;
  // the verdict is a snapshot: say so when evidence kept coming in afterwards
  const newFb = report ? ev.feedback - (report.stats.feedback || 0) : 0, newVis = report ? ev.visitors - (report.stats.visitors || 0) : 0;
  if (newFb > 0 || newVis > 0) $('#rpInfo').textContent = `⚠ 结论生成后又来了 ${[newVis > 0 && `${newVis} 位访客`, newFb > 0 && `${newFb} 条反馈`].filter(Boolean).join('、')}，点「生成 / 更新结论」更新`;
  lastReport = report; $('#rpIterate').hidden = !report || !(report.next.length || report.concerns.length);
}
$('#btnReport').onclick = openReport;
$('#rpClose').onclick = () => $('#dlgReport').close();
$('#rpIterate').onclick = async () => {
  const r = lastReport; if (!r) return;
  // a new validation round starts now: later visits and feedback are judged against this one
  try { await api(`/api/projects/${current.id}/rounds`, { method: 'POST', body: { reason: r.next.join('；').slice(0, 300) } }); } catch {}
  const msg = `根据试用验证的结论改出第二版 Demo，用来做下一轮验证。\n结论：${VERDICT_NAMES[r.verdict]}——${r.summary}\n${r.concerns.length ? `试用者的顾虑：\n${r.concerns.map(x => '- ' + x).join('\n')}\n` : ''}建议的下一步：\n${r.next.map(x => '- ' + x).join('\n')}\n请只做能在 Demo 里体现、帮助下一轮验证的改动（不能在 Demo 里验证的，如线下调研，写进总结里提醒我）；保持验证版的轻量，改完在电脑和手机上各看一次。`;
  $('#dlgReport').close();
  isBusy(current) ? enqueue(msg) : send(msg, { budget: FIRST_BUILD_BUDGET });
};
$('#rpShare').onclick = () => { $('#dlgReport').close(); openShare(); };
$('#rpGen').onclick = async () => {
  const b = $('#rpGen'); b.disabled = true; $('#rpInfo').textContent = 'AI 正在根据证据写结论…';
  try { const { report, evidence: ev, round, previous } = await api(`/api/projects/${current.id}/report`, { method: 'POST' }); renderRound(round, previous); renderReport(report, ev); loadProjects(); }
  catch (e) { $('#rpInfo').textContent = '✗ ' + e.message; b.disabled = false; }
};

/** After a build turn of an idea that hasn't been tried by anyone yet (no pre-test, no share): suggest the next step. */
function nudgePretest(key) { // key = view key "<projectId>:<session>"
  const pid = String(key).split(':')[0], p = projects.find(x => x.id === pid), v = p?.validation;
  if (autopiloting.has(pid)) return;
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
    ${t.fixes.length ? `<div class="lbl">分享前建议先改</div><ul>${li(t.fixes)}</ul><div class="row end"><button id="rpPreFix" class="ghost" title="分享给真人之前，先按模拟用户的意见修改（不开新一轮）">按模拟意见先改</button></div>` : ''}`;
  const fix = $('#rpPreFix');
  if (fix) fix.onclick = () => {
    const msg = pretestFixMessage(t);
    $('#dlgReport').close();
    isBusy(current) ? enqueue(msg) : send(msg, { budget: FIX_BUDGET });
  };
}
/** Capture pages, walk the core flow, run the simulated users. info(text) reports progress. */
async function runPretest(id, info = () => {}) {
  info('正在打开各页面…');
  const { pages } = await api(`/api/projects/${id}/pretest`);
  const snaps = await PageBot.capture(id, pages);
  info('规划并走一遍核心流程…');
  let walks = [];
  try {
    const plan = await api(`/api/projects/${id}/pretest/walks`, { method: 'POST', body: { pages: snaps } });
    walks = await PageBot.walk(id, plan.walks || [], (goal, text) => api(`/api/projects/${id}/pretest/continue`, { method: 'POST', body: { goal, text } }).then(r => r.actions || []));
  } catch {} // without walkthroughs the pre-test falls back to the agent's own page_act runs
  info(`4 位模拟用户正在试用 ${snaps.length} 个页面…`);
  const { pretest } = await api(`/api/projects/${id}/pretest`, { method: 'POST', body: { pages: snaps, walks } });
  loadProjects();
  return pretest;
}
const pretestFixMessage = t => `分享给真人试用前，先按 AI 模拟试用发现的问题改一下 Demo（模拟用户的意见只作参考，你判断不合理的可以不改，说明原因）。\n${t.confusions.length ? `容易看不懂的地方：\n${t.confusions.map(x => '- ' + x).join('\n')}\n` : ''}建议先改：\n${t.fixes.map(x => '- ' + x).join('\n')}\n保持验证版的轻量，只改这些；需要新页面的，只做能演示那一下的最小版本；改完在电脑和手机上各看一次。`;
$('#rpPretest').onclick = async () => {
  const id = current.id, b = $('#rpPretest'); b.disabled = true;
  try {
    if (current.status !== 'running') throw new Error('项目没在运行：先启动再试');
    const pretest = await runPretest(id, t => { $('#rpInfo').textContent = t; });
    if (current?.id === id) { renderPretest(pretest); $('#rpInfo').textContent = ''; $('#rpPre').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (e) { $('#rpInfo').textContent = '✗ ' + e.message; }
  finally { b.disabled = false; }
};

// ---------- phone layout: bottom tabs switch between projects / chat / preview ----------
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function setTab(t) {
  // chat / preview need a project: without one stay on the board and say why
  if (t !== 'projects' && !current) { t = 'projects'; setTimeout(() => alert('先在看板上点一个想法，或者点「＋ 新想法」新建一个'), 0); }
  document.body.classList.remove('m-projects', 'm-chat', 'm-preview', 'view-new');
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
  PageBot.init(); // find the demo origin early (and remember a public one)
  await loadProjects();
  const start = location.hash.match(/^#\/p\/(\w+)/)?.[1];
  if (start && projects.some(p => p.id === start)) await select(start); else showBoard(); // home = idea board (or the project in the address)
  renderHeader();
  if (!settings.hasKey) toggleSettings(true);
  setInterval(loadProjects, 5000);
})();
