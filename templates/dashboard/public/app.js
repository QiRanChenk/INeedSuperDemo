// 门店销售看板 — 前端逻辑。依赖 _sd/sd.js 提供的全局 sd（图表、表格、请求、格式化）。
const state = { days: 30, store: '', data: null, llm: false, seq: 0 };
const $ = sd.$;

// ---------- 格式化 ----------
const pct = (v, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const FORMAT = { money: v => sd.fmt.money(v, '¥', v >= 1000 ? 0 : 2), int: v => sd.fmt.num(v), pct: v => pct(v) };
const shortMoney = v => (Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : sd.fmt.num(v));
const mmdd = v => `${+v.slice(5, 7)}/${+v.slice(8, 10)}`;   // 2026-10-03 -> 10/3

function delta(k) {
  if (k.change == null) return '<div class="sd-stat-delta sd-muted">暂无上期数据对比</div>';
  const dir = k.change > 0.0005 ? 'up' : k.change < -0.0005 ? 'down' : '';
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '';
  const text = k.changeType === 'pt' ? `${Math.abs(k.change * 100).toFixed(1)} 个百分点` : pct(Math.abs(k.change));
  return `<div class="sd-stat-delta ${dir}">${arrow} ${text} <span class="sd-muted">较上期</span></div>`;
}

// ---------- 渲染 ----------
function renderKpis(kpis) {
  $('#kpis').innerHTML = kpis.map(k => `<div class="sd-stat"><div class="sd-stat-label">${sd.esc(k.label)}</div>
    <div class="sd-stat-value">${FORMAT[k.format](k.value)}</div>${delta(k)}</div>`).join('');
}

function renderCharts() {
  const d = state.data; if (!d) return;
  const h = id => Number($(id).dataset.h);
  const weekly = d.trend.unit === 'week';
  $('#trendNote').textContent = `${weekly ? '按周' : '按日'} · 共 ${sd.fmt.num(d.trend.orders.reduce((a, b) => a + b, 0))} 单`;
  sd.chart.line('#trend', { labels: d.trend.labels.map(l => mmdd(l) + (weekly ? '周' : '')), series: [{ name: '销售额', values: d.trend.revenue }] }, { height: h('#trend'), format: shortMoney });
  sd.chart.pie('#category', { labels: d.byCategory.map(r => r.name), values: d.byCategory.map(r => r.revenue) }, { height: h('#category'), format: shortMoney });
  sd.chart.bar('#stores', { labels: d.byStore.map(r => r.name), values: d.byStore.map(r => r.revenue) }, { horizontal: true, format: shortMoney }); // ranking: horizontal bars keep full names on phones
  sd.chart.bar('#channel', { labels: d.byChannel.map(r => `${r.name} ${pct(r.share, 0)}`), values: d.byChannel.map(r => r.revenue) }, { height: h('#channel'), format: shortMoney });
  const low = [...d.byChannel].sort((a, b) => a.margin - b.margin)[0];
  $('#channelNote').textContent = low ? `${low.name}毛利率最低（${pct(low.margin)}）` : '按销售额';
}

function renderProducts(rows) {
  sd.table('#products', {
    rows, empty: '这段时间还没有成交，换个时间范围看看',
    columns: [
      { key: 'name', label: '商品', primary: true, render: r => `<b>${rows.indexOf(r) + 1}. ${sd.esc(r.name)}</b><span class="sub">${sd.esc(r.category)}</span>` },
      { key: 'quantity', label: '销量', num: true, render: r => sd.fmt.num(r.quantity) },
      { key: 'revenue', label: '销售额', num: true, render: r => sd.fmt.money(r.revenue, '¥', 0) },
      { key: 'change', label: '较上期', num: true, render: r => (r.change == null ? `<span class="sd-muted">${state.data.period.comparable ? '新上榜' : '—'}</span>`
        : `<span class="${r.change >= 0 ? 'sd-ok' : 'sd-danger'}">${r.change >= 0 ? '+' : ''}${pct(r.change)}</span>`) },
      { key: 'margin', label: '毛利率', num: true, mobile: false, render: r => pct(r.margin) },
    ],
  });
}

function skeleton() {
  $('#kpis').innerHTML = '<div class="sd-stat"><div class="sd-skeleton" style="width:40%"></div><div class="sd-skeleton" style="height:28px;margin-top:10px"></div></div>'.repeat(4);
  for (const id of ['#trend', '#category', '#stores', '#channel']) $(id).innerHTML = `<div class="sd-skeleton" style="height:${$(id).dataset.h}px"></div>`;
  $('#products').innerHTML = '<div class="sd-stack" style="padding:16px">' + '<div class="sd-skeleton" style="height:20px"></div>'.repeat(5) + '</div>';
}

function insightHint() {
  $('#insight').innerHTML = `<div class="sd-empty">${state.llm
    ? '点「生成解读」，AI 会根据当前筛选的数据总结亮点、风险，并给出下一步建议'
    : '还没有配置 AI 模型，配置后即可一键生成经营解读'}</div>`;
  $('#insightBtn').disabled = !state.llm;
}

// ---------- 数据加载 ----------
async function load() {
  const seq = ++state.seq;
  if (state.data) $('#page').classList.add('is-loading'); else skeleton();
  try {
    const data = await sd.api(`api/dashboard?days=${state.days}&store=${encodeURIComponent(state.store)}`);
    if (seq !== state.seq) return;   // a newer filter change is in flight
    state.data = data;
    $('#asof').textContent = `统计至 ${data.period.to}`;
    renderKpis(data.kpis);
    renderCharts();
    renderProducts(data.topProducts);
    insightHint();
  } catch (e) {
    if (seq === state.seq) sd.toast('加载失败：' + e.message, 'error');
  } finally {
    if (seq === state.seq) $('#page').classList.remove('is-loading');
  }
}

async function generateInsight() {
  const btn = $('#insightBtn');
  $('#insight').innerHTML = '<div class="sd-stack">' + ['90%', '75%', '85%', '60%'].map(w => `<div class="sd-skeleton" style="width:${w}"></div>`).join('') + '<div class="sd-small sd-muted">AI 正在阅读数据，通常需要十几秒…</div></div>';
  try {
    const r = await sd.busy(btn, () => sd.api('api/insight', { body: { days: state.days, store: state.store } }));
    $('#insight').innerHTML = markdown(r.markdown);
  } catch (e) {
    $('#insight').innerHTML = `<div class="sd-empty">${sd.esc(e.message)}</div>`;
  }
}

// 极简 Markdown：标题、加粗、列表、段落、分隔线。先转义再加标签，杜绝注入。
function markdown(src) {
  const inline = s => sd.esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = []; let para = [], list = null;
  const endPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  const endList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trim(); let m;
    if (!line) { endPara(); endList(); }
    else if ((m = line.match(/^(#{1,6})\s+(.+)$/))) { endPara(); endList(); const t = m[1].length <= 2 ? 'h3' : 'h4'; out.push(`<${t}>${inline(m[2])}</${t}>`); }
    else if (/^([-*_])\1{2,}$/.test(line)) { endPara(); endList(); out.push('<hr>'); }
    else if ((m = line.match(/^([-*+]|\d+[.)])\s+(.+)$/))) {
      const t = /\d/.test(m[1]) ? 'ol' : 'ul';
      endPara(); if (list !== t) { endList(); out.push(`<${t}>`); list = t; }
      out.push(`<li>${inline(m[2])}</li>`);
    } else { endList(); para.push(line); }
  }
  endPara(); endList();
  return out.join('');
}

// ---------- 交互 ----------
sd.tabs('#days', v => { state.days = Number(v); load(); });
$('#store').addEventListener('change', e => { state.store = e.target.value; load(); });
$('#insightBtn').addEventListener('click', generateInsight);
let lastWidth = innerWidth;
addEventListener('resize', sd.debounce(() => { if (innerWidth !== lastWidth) { lastWidth = innerWidth; renderCharts(); } }, 200));

(async function init() {
  skeleton();
  try {
    const info = await sd.api('api/info');
    state.llm = info.llmConfigured;
    $('#brand').textContent = info.project;
    document.title = info.project;
    $('#store').insertAdjacentHTML('beforeend', info.stores.map(s => `<option value="${sd.esc(s)}">${sd.esc(s)}</option>`).join(''));
  } catch (e) {
    sd.toast('加载失败：' + e.message, 'error');
  }
  load();
})();
