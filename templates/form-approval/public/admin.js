// 审核台：指标 + 按状态分页签的列表 + 通过/驳回 + 详情。字段展示复用 fields.js 的 FIELDS。
const state = { status: '待审核', q: '', page: 1, pageSize: 10 };
let reviewer = localStorage.getItem('reviewer') || '';

function showReviewer() { sd.$('#reviewerBtn').textContent = `审核人：${reviewer || '未设置'}`; }
async function askReviewer() {
  const v = await sd.formModal({ title: '设置审核人', submitText: '确定', values: { reviewer },
    fields: [{ name: 'reviewer', label: '你的姓名', required: true, hint: '会记录在审核结果中' }] });
  if (!v) return false;
  reviewer = v.reviewer; localStorage.setItem('reviewer', reviewer); showReviewer();
  return true;
}

const query = () => new URLSearchParams({ status: state.status, q: state.q }).toString();

async function loadList() {
  const { rows, total } = await sd.api(`api/submissions?${query()}&page=${state.page}&pageSize=${state.pageSize}`);
  const pending = r => r.status === '待审核';
  sd.table('#list', {
    rows,
    empty: state.q ? '没有符合条件的报名，换个关键词试试' : state.status === '待审核' ? '暂无待审核的报名，新的报名提交后会出现在这里' : '这里还没有记录',
    columns: [
      { key: 'name', label: '报名人', render: r => `<div><b>${sd.esc(r.name)}</b><div class="sd-small sd-muted">${sd.esc(r.company)}${r.title ? ' · ' + sd.esc(r.title) : ''}</div></div>` },
      { key: 'session', label: '场次', render: r => `<span class="sd-small">${sd.esc(r.session)}</span>` },
      { key: 'attendees', label: '人数', num: true },
      { key: 'created_at', label: '提交时间', render: r => `<span class="sd-small" title="${sd.esc(r.created_at)}">${sd.fmt.ago(r.created_at)}</span>` },
      { key: 'status', label: '状态', render: r => statusTag(r.status) },
    ],
    actions: [
      { text: '通过', primary: true, show: pending, onClick: r => approve(r) },
      { text: '驳回', danger: true, show: pending, onClick: r => reject(r) },
    ],
    onRowClick: showDetail,
  });
  sd.pager('#pager', { page: state.page, pageSize: state.pageSize, total, onChange: p => { state.page = p; loadList(); } });
  sd.$('#exportBtn').href = `api/submissions/export.csv?${query()}`;
}

async function loadStats() {
  const s = await sd.api('api/submissions/stats');
  sd.$$('[data-stat]').forEach(el => (el.textContent = sd.fmt.num(el.dataset.stat === 'today' ? s.today : s.byStatus[el.dataset.stat])));
  sd.$$('#tabs [data-value]').forEach(t => (t.querySelector('.count').textContent = t.dataset.value ? s.byStatus[t.dataset.value] : s.total));
  sd.$('#sessions').innerHTML = s.bySession.map(x => `<li><div class="sd-spacer"><div>${sd.esc(x.session)}</div>
    <div class="sd-small sd-muted">报名 ${x.total} 份 · 已通过 ${x.approved} 份</div></div><div class="people"><b>${x.people}</b><span class="sd-small sd-muted"> 人到场</span></div></li>`).join('');
}

const refresh = () => Promise.all([loadList(), loadStats()]).catch(e => sd.toast(e.message, 'error'));

async function review(r, status, note = '') {
  if (!reviewer && !(await askReviewer())) return false;
  await sd.api(`api/submissions/${r.id}/review`, { body: { status, note, reviewer } });
  sd.toast(`已${status === '已通过' ? '通过' : '驳回'}「${r.name}」的报名`);
  refresh();
  return true;
}
async function approve(r) {
  if (await sd.confirm(`确定通过「${r.name}」（${r.company}）的报名？`, { okText: '通过' })) await review(r, '已通过').catch(e => sd.toast(e.message, 'error'));
}
function reject(r) {
  return sd.formModal({ title: `驳回「${r.name}」的报名`, submitText: '确认驳回',
    fields: [{ name: 'note', label: '驳回原因', type: 'textarea', required: true, placeholder: '报名人查询进度时可以看到，如：本场次名额已满，可改报其他场次' }],
    onSubmit: async v => { if (!(await review(r, '已驳回', v.note))) throw new Error('请先设置审核人'); } });
}

function showDetail(r) {
  const kv = (label, html) => `<dt>${sd.esc(label)}</dt><dd>${html || '<span class="sd-muted">—</span>'}</dd>`;
  const content = `<dl class="kv">
    ${kv('报名编号', sd.esc(r.code))}${kv('提交时间', sd.fmt.datetime(r.created_at))}
    ${FIELDS.map(f => kv(f.label, sd.esc(r[f.name]))).join('')}
  </dl>
  <h4 class="kv-title">审核记录</h4>
  <dl class="kv">
    ${kv('状态', statusTag(r.status))}
    ${r.status === '待审核' ? '' : kv('审核人', sd.esc(r.reviewer)) + kv('审核时间', sd.fmt.datetime(r.reviewed_at)) + kv('审核意见', sd.esc(r.review_note))}
  </dl>`;
  const actions = [{ text: '关闭' }];
  if (r.status !== '已驳回') actions.push({ text: r.status === '已通过' ? '改为驳回' : '驳回', danger: true, onClick: () => { reject(r); } });
  if (r.status !== '已通过') actions.push({ text: r.status === '已驳回' ? '改为通过' : '通过', primary: true, onClick: () => review(r, '已通过').catch(e => { sd.toast(e.message, 'error'); return false; }) });
  sd.modal({ title: `${r.name} 的报名`, content, actions, width: 560 });
}

sd.tabs('#tabs', v => { state.status = v; state.page = 1; loadList(); });
sd.$('#q').addEventListener('input', sd.debounce(e => { state.q = e.target.value.trim(); state.page = 1; loadList(); }, 300));
sd.$('#reviewerBtn').onclick = askReviewer;
sd.api('api/info').then(info => sd.$$('[data-project]').forEach(el => (el.textContent = info.project))).catch(() => {});
showReviewer();
refresh();
