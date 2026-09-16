const $ = s => document.querySelector(s);
let projects = [], current = null, settings = null;
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
  await Promise.all([loadHistory(), loadUsage()]);
}

// ---------- token usage ----------
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n);
function usageLine(u) {
  if (!u || !u.calls) return '<span class="muted">暂无</span>';
  const hit = u.input ? Math.round(u.cached / u.input * 100) : 0;
  return `输入 <b>${fmt(u.input)}</b> <span class="sep">·</span> 输出 <b>${fmt(u.output)}</b> <span class="sep">·</span> 缓存命中 <b>${hit}%</b> <span class="sep">·</span> 合计 <b>${fmt(u.total)}</b> <span class="sep">·</span> ${u.calls} 次调用`;
}
function renderUsage(pid, data) {
  if (current?.id !== pid) return;
  $('#usage').hidden = false;
  $('#uSession').innerHTML = usageLine(data.session);
  $('#uProject').innerHTML = usageLine(data.project);
}
async function loadUsage() {
  if (!current) { $('#usage').hidden = true; return; }
  const pid = current.id;
  try { renderUsage(pid, await api(`/api/projects/${pid}/usage`)); } catch {}
}

function renderHeader() {
  const has = !!current, busy = isBusy(current);
  const live = has && (current.status === 'running' || current.status === 'starting');
  for (const id of ['btnToggle', 'btnLogs', 'btnFiles', 'btnDelete']) $('#' + id).disabled = !has;
  $('#btnRestart').disabled = !live;
  $('#btnToggle').textContent = live ? '■ 停止' : '▶ 启动';
  $('#btnToggle').classList.toggle('start', has && !live);
  document.body.classList.toggle('no-preview', has && !live);
  if (has && !live && $('#frame').src !== 'about:blank') $('#frame').src = 'about:blank';
  if (live && current.hasUi && $('#frame').src === 'about:blank') $('#frame').src = `/p/${current.id}/`;
  $('#btnClear').disabled = !has || busy;
  $('#send').disabled = !has || busy;
  $('#send').textContent = busy ? '处理中…' : '发送';
  $('#pName').textContent = current ? current.name : '选择或新建一个项目';
  $('#pMeta').textContent = current ? `${current.typeLabel} · ${current.status} · 端口 ${current.port} · id ${current.id}` : '';
}

/** Full replay of the persisted history, including the thinking process (tool calls, results, restarts, reasoning). */
async function loadHistory() {
  if (!current) return;
  const pid = current.id;
  const hist = await api(`/api/projects/${pid}/history`);
  if (current?.id !== pid) return; // switched while fetching
  const box = $('#messages'); box.innerHTML = '';
  for (const m of hist) {
    if (m.role === 'user') { m.system ? addSys(pid, firstLine(m.content)) : addMsg(pid, 'user', m.content); continue; }
    if (m.role === 'assistant') {
      if (m.reasoning) addReasoning(pid, m.reasoning);
      if (m.content) addMsg(pid, 'assistant', m.content);
      for (const tc of m.tool_calls || []) addTool(pid, tc.function.name, safeParse(tc.function.arguments));
      continue;
    }
    if (m.role === 'tool') addToolResult(pid, m.name, m.content);
  }
  if (!hist.length) addSys(pid, '项目已就绪。右侧是实时预览，在下方告诉 AI 你想怎么改，它会边改边重启。');
  if (isBusy(current)) showThinking(pid, '处理中…');
  box.scrollTop = box.scrollHeight;
}

// ---------- rendering (all bound to a project id; ignored if the user switched away) ----------
/** Append and auto-scroll: follows new content unless the user has scrolled up to read history. */
function append(pid, el, force = false) {
  if (current?.id !== pid) return el;
  const box = $('#messages');
  const follow = force || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const t = $('#thinking'); t ? box.insertBefore(el, t) : box.appendChild(el);
  if (follow) box.scrollTop = box.scrollHeight;
  return el;
}
function addMsg(pid, role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; return append(pid, d, role === 'user'); }
function addSys(pid, text) { return addMsg(pid, 'sys', text); }
function addTool(pid, name, args) {
  const d = document.createElement('div'); d.className = 'tool';
  const a = args && (args.path || args.command || (args.lines ? `${args.lines} lines` : ''));
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
  if (current?.id !== pid) return;
  let t = $('#thinking');
  if (!t) { t = document.createElement('div'); t.id = 'thinking'; t.className = 'msg sys thinking'; $('#messages').appendChild(t); }
  t.textContent = text;
  const box = $('#messages'); if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}
function hideThinking(pid) { if (current?.id === pid) $('#thinking')?.remove(); }

// ---------- chat ----------
async function send(text) {
  if (!current || isBusy(current) || !text.trim()) return;
  const pid = current.id;
  streams.set(pid, true); renderHeader();
  addMsg(pid, 'user', text);
  $('#input').value = '';
  showThinking(pid, '思考中…');
  try {
    const res = await fetch(`/api/projects/${pid}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
        handleEvent(pid, JSON.parse(line.slice(6)));
      }
    }
  } catch (e) { addMsg(pid, 'error', e.message); }
  finally { streams.delete(pid); wasBusy.set(pid, false); hideThinking(pid); renderHeader(); loadProjects(); }
}

function handleEvent(pid, ev) {
  switch (ev.type) {
    case 'thinking': showThinking(pid, `思考中… (第 ${ev.iteration} 轮)`); break;
    case 'usage': renderUsage(pid, ev); break;
    case 'reasoning': addReasoning(pid, ev.content); break;
    case 'text': addMsg(pid, 'assistant', ev.content); break;
    case 'tool_call': addTool(pid, ev.name, ev.args); break;
    case 'tool_result': addToolResult(pid, ev.name, ev.preview); break;
    case 'restarting': addSys(pid, '↻ 文件已修改，重启项目…'); break;
    case 'restarted': addSys(pid, ev.status === 'running' ? '✓ 项目已重启' : '✗ 重启后状态: ' + ev.status); if (ev.status === 'running' && current?.id === pid) setTimeout(reloadFrame, 400); break;
    case 'done': addMsg(pid, 'assistant', ev.content); if (current?.id === pid) reloadFrame(); break;
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
  $('#stTemp').value = settings.temperature; $('#stIter').value = settings.maxIterations;
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
  const panel = $('#settingsPanel');
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  $('#openSettings').classList.toggle('open', show);
  localStorage.setItem('sd.settingsOpen', show ? '1' : '0');
  if (show) $('#stResult').textContent = '';
}
async function saveSettings() {
  const body = { baseUrl: $('#stBase').value, model: $('#stModel').value, temperature: $('#stTemp').value, maxIterations: $('#stIter').value, projectLlm: collectProjectLlm() };
  if ($('#stKey').value) body.apiKey = $('#stKey').value;
  const saved = await api('/api/settings', { method: 'PUT', body });
  await loadSettings();
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
$('#openSettings').onclick = () => toggleSettings();
$('#stClose').onclick = () => toggleSettings(false);

// ---------- new project ----------
$('#newProject').onclick = async () => {
  const types = await api('/api/project-types');
  const sel = $('#npType'); sel.innerHTML = '';
  for (const t of types) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; o.disabled = !t.available; sel.appendChild(o); }
  $('#npName').value = ''; $('#npDesc').value = '';
  $('#dlgNew').showModal();
};
$('#dlgNew form').onsubmit = async e => {
  if (e.submitter?.value !== 'ok') return;
  const name = $('#npName').value.trim(), description = $('#npDesc').value.trim(), type = $('#npType').value;
  try {
    const p = await api('/api/projects', { method: 'POST', body: { name, description, type } });
    await loadProjects(); await select(p.id);
    if (description) send(`请根据以下需求改造这个项目：\n${description}`);
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
$('#btnClear').onclick = async () => { if (confirm('清空该项目的对话历史？（不影响代码，项目累计 token 保留）')) { await api(`/api/projects/${current.id}/history`, { method: 'DELETE' }); await Promise.all([loadHistory(), loadUsage()]); } };
$('#btnDelete').onclick = async () => {
  if (!confirm(`删除项目「${current.name}」及其全部文件？不可恢复。`)) return;
  await api(`/api/projects/${current.id}`, { method: 'DELETE' });
  current = null; $('#frame').src = 'about:blank'; $('#messages').innerHTML = ''; $('#usage').hidden = true;
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
$('#composer').onsubmit = e => { e.preventDefault(); send($('#input').value); };
$('#input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#input').value); } };

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeParse = s => { try { return JSON.parse(s); } catch { return {}; } };
const firstLine = s => String(s ?? '').split('\n')[0].replace(/^\[系统\]\s*/, '↻ ').slice(0, 120);

(async () => {
  await loadSettings();
  await loadProjects();
  if (projects.length) await select(projects[0].id);
  renderHeader();
  const open = localStorage.getItem('sd.settingsOpen');
  if (open === '1' || (open === null && !settings.hasKey)) toggleSettings(true);
  setInterval(loadProjects, 5000);
})();
