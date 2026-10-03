// 管理后台（增删改查）前端 — 示例实体：客户。
// To adapt to another entity: change ENTITY / API and the FIELDS array below (keep in sync with server.js FIELDS),
// then the KPI cards in renderStats(). Form, table, detail view and filters all read from FIELDS.
const ENTITY = '客户';
const API = 'api/customers';                     // relative URL (no leading "/")

const LEVELS = ['A', 'B', 'C'];
const STATUSES = ['潜在', '跟进中', '已成交', '已流失'];
const STATUS_TAG = { 潜在: 'info', 跟进中: 'warn', 已成交: 'ok', 已流失: '' };   // sd-tag colour per status
const LEVEL_TAG = { A: 'brand', B: 'info', C: '' };
const money = v => (v == null || v === '' ? '' : sd.fmt.money(v, '¥', 0));

// ---- ONE place for fields: form modal (type/options/required…), table column (list/render), detail view ----
// list: show as a table column; render(row) -> HTML (escape user text with sd.esc); num: right-aligned number;
// mobile: false -> column hidden on phone cards (keep cards to ~5 lines)
const FIELDS = [
  { name: 'name', label: '客户姓名', required: true, list: true, primary: true, placeholder: '如：王建国',
    render: r => `<b>${sd.esc(r.name)}</b>` },
  { name: 'company', label: '公司', list: true },
  { name: 'phone', label: '电话', type: 'tel', list: true, mobile: false, placeholder: '手机或座机' },
  { name: 'email', label: '邮箱', type: 'email' },
  { name: 'city', label: '城市', list: true, mobile: false },
  { name: 'level', label: '客户等级', type: 'select', options: LEVELS.map(l => ({ value: l, label: l + ' 级' })), required: true, list: true,
    render: r => r.level ? sd.tag(r.level + ' 级', LEVEL_TAG[r.level]) : '' },
  { name: 'status', label: '跟进状态', type: 'select', options: STATUSES, required: true, list: true,
    render: r => r.status ? sd.tag(r.status, STATUS_TAG[r.status]) : '' },
  { name: 'owner', label: '负责人', list: true, mobile: false },
  { name: 'amount', label: '预计金额', type: 'number', min: 0, hint: '单位：元', list: true, num: true,
    render: r => money(r.amount) },
  { name: 'note', label: '备注', type: 'textarea', placeholder: '最近一次沟通情况、下一步计划' },
];
const DEFAULTS = { level: 'B', status: '潜在' };   // initial values for a new record

// ---- state ----
const state = { q: '', status: '', level: '', sort: '-created_at', page: 1, pageSize: 10 };
const query = (extra = {}) => new URLSearchParams(Object.entries({ ...state, ...extra }).filter(([, v]) => v !== '')).toString();

// ---- KPI cards ----
async function renderStats() {
  const s = await sd.api(`${API}/stats`);
  const card = (label, value, sub = '') => `<div class="sd-stat"><div class="sd-stat-label">${label}</div>
    <div class="sd-stat-value">${value}</div>${sub ? `<div class="sd-stat-delta">${sub}</div>` : ''}</div>`;
  sd.$('#stats').innerHTML = [
    card('客户总数', sd.fmt.num(s.total), `<span class="sd-muted">潜在 ${s.byStatus['潜在']} 家</span>`),
    card('本月新增', sd.fmt.num(s.newThisMonth), '<span class="sd-muted">按创建时间统计</span>'),
    card('跟进中', sd.fmt.num(s.byStatus['跟进中']), `<span class="sd-muted">已流失 ${s.byStatus['已流失']} 家</span>`),
    card('已成交金额', money(s.wonAmount), `<span class="sd-ok">已成交 ${s.byStatus['已成交']} 家</span>`),
  ].join('');
}

// ---- list ----
async function load() {
  try {
    const { rows, total } = await sd.api(`${API}?${query()}`);
    if (!rows.length && total && state.page > 1) { state.page--; return load(); }   // page emptied by a delete
    const filtered = state.q || state.status || state.level;
    sd.table('#list', {
      columns: [...FIELDS.filter(f => f.list).map(f => ({ key: f.name, label: f.label, num: f.num, render: f.render, mobile: f.mobile, primary: f.primary })),
        { key: 'created_at', label: '创建日期', mobile: false, render: r => sd.fmt.date(r.created_at) }],
      rows,
      empty: filtered ? `没有找到符合条件的${ENTITY}，换个关键词或清除筛选试试` : `还没有${ENTITY}，点右上角「新增${ENTITY}」添加第一条`,
      actions: [{ text: '编辑', onClick: edit }, { text: '删除', danger: true, onClick: remove }],
      onRowClick: detail,
    });
    sd.pager('#pager', { page: state.page, pageSize: state.pageSize, total, onChange: p => { state.page = p; load(); } });
  } catch (e) {
    sd.$('#list').innerHTML = `<div class="sd-empty">加载失败：${sd.esc(e.message)}，请刷新页面重试</div>`;
  }
}
const refresh = () => Promise.all([load(), renderStats()]);

// ---- create / edit / delete / detail ----
async function edit(row) {
  const isNew = !row?.id;
  const saved = await sd.formModal({
    title: isNew ? `新增${ENTITY}` : `编辑${ENTITY}`,
    fields: FIELDS,
    values: isNew ? DEFAULTS : row,
    onSubmit: v => (isNew ? sd.api(API, { body: v }) : sd.api(`${API}/${row.id}`, { method: 'PUT', body: v })),
  });
  if (!saved) return;
  sd.toast(isNew ? `已新增${ENTITY}「${saved.name}」` : '已保存修改');
  if (isNew) state.page = 1;
  refresh();
}

async function remove(row) {
  if (!(await sd.confirm(`确定删除${ENTITY}「${row.name}」？删除后无法恢复。`, { danger: true, okText: '删除' }))) return;
  try {
    await sd.api(`${API}/${row.id}`, { method: 'DELETE' });
    sd.toast('已删除');
    refresh();
  } catch (e) { sd.toast('删除失败：' + e.message, 'error'); }
}

function detail(row) {
  const value = f => (f.render ? f.render(row) : sd.esc(row[f.name])) || '<span class="sd-muted">—</span>';
  const items = [...FIELDS.map(f => [f.label, value(f)]),
    ['创建时间', sd.fmt.datetime(row.created_at)], ['最近更新', sd.fmt.datetime(row.updated_at)]];
  sd.modal({
    title: row.name,
    content: `<dl class="detail">${items.map(([k, v]) => `<dt>${sd.esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`,
    actions: [
      { text: '删除', danger: true, onClick: () => { remove(row); } },
      { text: '编辑', primary: true, onClick: () => { edit(row); } },
    ],
  });
}

// ---- toolbar ----
function initToolbar() {
  // status segmented control built from STATUSES
  sd.$('#statusSeg').innerHTML = ['', ...STATUSES].map(s => `<button type="button" data-value="${sd.esc(s)}"${s ? '' : ' class="active"'}>${sd.esc(s || '全部')}</button>`).join('');
  sd.tabs('#statusSeg', v => { state.status = v; state.page = 1; load(); });
  sd.$('#level').innerHTML = '<option value="">全部等级</option>' + LEVELS.map(l => `<option value="${l}">${l} 级客户</option>`).join('');
  sd.$('#level').onchange = e => { state.level = e.target.value; state.page = 1; load(); };
  sd.$('#sort').onchange = e => { state.sort = e.target.value; state.page = 1; load(); };
  sd.$('#q').oninput = sd.debounce(e => { state.q = e.target.value.trim(); state.page = 1; load(); }, 300);
  sd.$('#btnAdd').onclick = () => edit();
  // download the current filter result (page/pageSize ignored by the server)
  sd.$('#btnExport').onclick = () => { location.href = `${API}/export.csv?${query()}`; sd.toast('正在导出…'); };
}

async function init() {
  sd.api('api/info').then(i => { if (i?.project) { sd.$('#brand').textContent = i.project; document.title = `${ENTITY}管理 · ${i.project}`; } }).catch(() => {});
  initToolbar();
  refresh();
}
init();
