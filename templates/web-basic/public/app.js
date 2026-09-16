// NOTE: all URLs are relative ("api/...") because this app is served under a sub-path by the shell.
const $ = s => document.querySelector(s);
let catalog = [], directions = [], selected = new Set(['growth', 'risk', 'action']);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function init() {
  const info = await api('api/info');
  document.title = $('#title').textContent = info.project + ' · 数据洞察';
  directions = info.directions;
  renderChips();
  if (!info.llmConfigured) $('#status').innerHTML = '<span class="error">智能分析暂不可用，请联系管理员完成配置</span>';
  await Promise.all([loadSources(), loadHistory()]);
}

async function loadHistory() {
  const list = await api('api/analyses');
  const ul = $('#history');
  if (!list.length) { ul.textContent = '暂无'; return; }
  ul.className = 'hist';
  ul.innerHTML = list.map(a => `<li data-id="${a.id}"><span class="t">${esc(a.created_at)}</span><span class="q">${esc(a.question || '整体分析')} · ${esc(String(a.ref).split('/').pop())}</span></li>`).join('');
  ul.onclick = async e => { const li = e.target.closest('li'); if (!li) return; const a = await api(`api/analyses/${li.dataset.id}`); $('#resultCard').hidden = false; $('#result').innerHTML = md(a.markdown); $('#resultCard').scrollIntoView({ behavior: 'smooth' }); };
}

async function loadSources() {
  catalog = await api('api/datasources');
  const sel = $('#source');
  sel.innerHTML = '';
  const GROUP = { file: '文件', database: '数据表', api: '在线数据' };
  for (const src of catalog) {
    const items = src.items.filter(it => it.id !== '__error__');
    if (!items.length) continue;
    const g = document.createElement('optgroup'); g.label = GROUP[src.kind] || src.kind;
    for (const it of items) {
      const o = document.createElement('option');
      o.value = `${src.name}/${it.id}`; o.textContent = it.label + (it.meta?.rows != null ? `（${it.meta.rows} 行）` : '');
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (sel.value) await preview();
}

async function preview() {
  const ref = $('#source').value;
  const box = $('#preview');
  box.className = 'preview muted'; box.textContent = '加载中…';
  try {
    const t = await api(`api/data?ref=${encodeURIComponent(ref)}&limit=30`);
    const rows = t.rows.map(r => t.columns.map(c => cell(r[c])));
    box.className = 'preview';
    box.innerHTML = `<div class="meta muted">${t.total} 行 · ${t.columns.length} 列（预览前 ${rows.length} 行）</div>
      <table><thead><tr>${t.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } catch (e) { box.className = 'preview error'; box.textContent = '读取失败：' + e.message; }
}

function renderChips() {
  const box = $('#directions'); box.innerHTML = '';
  for (const d of directions) {
    const c = document.createElement('span');
    c.className = 'chip' + (selected.has(d.id) ? ' on' : ''); c.textContent = d.label; c.title = d.hint;
    c.onclick = () => { selected.has(d.id) ? selected.delete(d.id) : selected.add(d.id); renderChips(); };
    box.appendChild(c);
  }
}

async function analyze() {
  const btn = $('#analyze'), st = $('#status');
  btn.disabled = true; st.textContent = 'AI 正在阅读数据并思考…（通常 10–40 秒）';
  try {
    const r = await api('api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: $('#source').value, question: $('#question').value, context: $('#context').value, directions: [...selected] }) });
    $('#resultCard').hidden = false;
    $('#result').innerHTML = md(r.markdown);
    st.textContent = '分析完成，已保存到历史记录';
    $('#resultCard').scrollIntoView({ behavior: 'smooth' });
    loadHistory();
  } catch (e) { st.innerHTML = `<span class="error">失败：${esc(e.message)}</span>`; }
  finally { btn.disabled = false; }
}

async function upload(file) {
  const text = await file.text();
  const r = await api(`api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text });
  await loadSources();
  $('#source').value = r.ref; await preview();
  $('#status').textContent = `已导入「${r.imported.table}」，共 ${r.imported.imported} 行`;
}

// tiny markdown renderer: headings, bold, lists, tables, paragraphs
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n'); let out = '', list = null, table = [];
  const flushList = () => { if (list) { out += `</${list}>`; list = null; } };
  const flushTable = () => { if (table.length) { const [h, , ...b] = table; out += `<table><thead><tr>${cells(h).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`; table = []; } };
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|');
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*\|/.test(l)) { flushList(); table.push(l); continue; } else flushTable();
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { flushList(); out += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { flushList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.、)]\s+(.*)/))) { if (list !== 'ol') { flushList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) flushList();
    else { flushList(); out += `<p>${inline(l)}</p>`; }
  }
  flushList(); flushTable();
  return out;
}
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\*(.+?)\*/g, '<em>$1</em>');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cell = v => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v;

$('#source').onchange = preview;
$('#reload').onclick = loadSources;
$('#analyze').onclick = analyze;
$('#file').onchange = e => e.target.files[0] && upload(e.target.files[0]);
init().catch(e => $('#status').innerHTML = `<span class="error">${esc(e.message)}</span>`);
