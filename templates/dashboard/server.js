import { createApp, openDb, llm, analyze } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || '门店销售看板';
const db = openDb('data/app.db');

// ================= 数据口径（换数据集时只改这一段） =================
// 换成别的业务表：改 TABLE / DATE / DIMS 指向新表的列名，METRICS 里的 SQL 表达式按新表的金额、成本列改写，
// KPIS 决定顶部四个指标卡。前端按返回的 label / format 渲染，无需改动。
// 日期列须是 'YYYY-MM-DD' 文本；统计区间以表里最新日期为终点（导入历史数据也能直接看）。
const TABLE = 'orders';
const DATE = 'order_date';
const DIMS = { store: 'store', category: 'category', channel: 'channel', product: 'product' };
const METRICS = `ROUND(SUM(amount), 2) AS revenue, COUNT(*) AS orders, SUM(quantity) AS quantity,
  ROUND(1 - SUM(cost) / NULLIF(SUM(amount), 0), 4) AS margin`;
const KPIS = [
  { key: 'revenue', label: '销售额', format: 'money' },
  { key: 'orders', label: '订单数', format: 'int' },
  { key: 'aov', label: '客单价', format: 'money', calc: r => (r.orders ? r.revenue / r.orders : 0) },
  { key: 'margin', label: '毛利率', format: 'pct', change: 'pt' },   // pt = 按百分点比较，其余按增长率
];
const PERIODS = [7, 30, 90];
// ===================================================================

db.ensureTable(TABLE, `id INTEGER PRIMARY KEY AUTOINCREMENT, order_date TEXT NOT NULL, store TEXT NOT NULL,
  category TEXT NOT NULL, product TEXT NOT NULL, quantity INTEGER NOT NULL, amount REAL NOT NULL, cost REAL NOT NULL,
  channel TEXT NOT NULL, member INTEGER NOT NULL DEFAULT 0`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_date ON ${TABLE} (${DATE})`);
if (!db.count(TABLE)) db.insertMany(TABLE, seedOrders());

// ---------------- 查询 ----------------
const shift = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const dataRange = () => { const r = db.get(`SELECT MIN(${DATE}) AS a, MAX(${DATE}) AS b FROM ${TABLE}`); return { from: r?.a || today(), to: r?.b || today() }; };
const storeList = () => db.query(`SELECT ${DIMS.store} AS name FROM ${TABLE} GROUP BY 1 ORDER BY SUM(amount) DESC`).map(r => r.name);

/** Aggregate METRICS over [from, to], optionally per group expression `by` (constants only, never user input). */
function agg({ from, to, store, by, extra = '', order = 'revenue DESC', limit }) {
  const params = [from, to];
  let where = `${DATE} BETWEEN ? AND ?`;
  if (store) { where += ` AND ${DIMS.store} = ?`; params.push(store); }
  const sql = `SELECT ${by ? `${by} AS name, ` : ''}${extra}${METRICS} FROM ${TABLE} WHERE ${where}`
    + (by ? ` GROUP BY 1 ORDER BY ${order}` : '') + (limit ? ` LIMIT ${Number(limit)}` : '');
  return db.query(sql, params);
}

const growth = (cur, prev) => (prev ? (cur - prev) / prev : null);

/** Group by a dimension for current and previous period; adds share and change (vs previous, null when prev = null). */
function breakdown(by, cur, prev, store, opts = {}) {
  const rows = agg({ ...cur, store, by, ...opts });
  const before = new Map(prev ? agg({ ...prev, store, by }).map(r => [r.name, r.revenue]) : []);
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return rows.map(r => ({ ...r, share: total ? r.revenue / total : 0, change: growth(r.revenue, before.get(r.name)) }));
}

function buildDashboard(days, store) {
  const range = dataRange(), end = range.to;
  const cur = { from: shift(end, 1 - days), to: end };
  const prev = { from: shift(end, 1 - 2 * days), to: shift(end, -days) };
  const comparable = prev.from >= range.from;   // previous period fully covered by data; otherwise no change shown
  const [c = {}] = agg({ ...cur, store }), [p = {}] = agg({ ...prev, store });
  const kpis = KPIS.map(k => {
    const value = k.calc ? k.calc(c) : c[k.key] ?? 0, before = k.calc ? k.calc(p) : p[k.key] ?? 0;
    const change = !comparable ? null : k.change === 'pt' ? (p.orders ? value - before : null) : growth(value, before);
    return { key: k.key, label: k.label, format: k.format, changeType: k.change || 'ratio', value, prev: before, change };
  });

  // trend: daily buckets, weekly (Monday-based) for long periods; empty days filled with 0
  const weekly = days > 31;
  const bucket = weekly ? `date(${DATE}, '-6 days', 'weekday 1')` : DATE;
  const points = new Map(agg({ ...cur, store, by: bucket, order: 'name' }).map(r => [r.name, r]));
  const labels = [];
  const monday = day => shift(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
  for (let d = weekly ? monday(cur.from) : cur.from; d <= cur.to; d = shift(d, weekly ? 7 : 1)) labels.push(d);
  const trend = { unit: weekly ? 'week' : 'day', labels,
    revenue: labels.map(d => points.get(d)?.revenue || 0), orders: labels.map(d => points.get(d)?.orders || 0) };

  const base = comparable ? prev : null;
  return {
    period: { days, store: store || '', from: cur.from, to: cur.to, prevFrom: prev.from, prevTo: prev.to, comparable },
    kpis, trend,
    byCategory: breakdown(DIMS.category, cur, base, store),
    byStore: breakdown(DIMS.store, cur, base, ''),   // 门店排行始终对比全部门店
    byChannel: breakdown(DIMS.channel, cur, base, store),
    topProducts: breakdown(DIMS.product, cur, base, store, { extra: `MAX(${DIMS.category}) AS category, `, limit: 10 }),
  };
}

function readFilters(src = {}) {
  const days = PERIODS.includes(Number(src.days)) ? Number(src.days) : 30;
  const store = storeList().includes(src.store) ? src.store : '';
  return { days, store };
}

// ---------------- 路由 ----------------
const app = createApp();

app.get('api/info', (req, res, ctx) => {
  ctx.json({ project: PROJECT, llmConfigured: llm.isConfigured(), periods: PERIODS, stores: storeList(), range: dataRange() });
});

app.get('api/dashboard', (req, res, ctx) => {
  const { days, store } = readFilters(ctx.query);
  ctx.json(buildDashboard(days, store));
});

app.post('api/insight', async (req, res, ctx) => {
  if (!llm.isConfigured()) return ctx.json({ error: '还没有配置 AI 模型，请先在设置中填写模型信息后再试' }, 400);
  const { days, store } = readFilters(ctx.body || {});
  const d = buildDashboard(days, store);
  // feed aggregates (not raw rows) to the model: one row per dimension member
  const pct = v => (v == null ? null : Math.round(v * 1000) / 10);
  const rows = [['品类', d.byCategory], ['门店', d.byStore], ['渠道', d.byChannel], ['热销商品', d.topProducts]].flatMap(([dim, list]) =>
    list.map(r => ({ 维度: dim, 名称: r.name, 本期销售额: r.revenue, 订单数: r.orders, 销量: r.quantity, '毛利率%': pct(r.margin), '销售占比%': pct(r.share), '环比增长%': pct(r.change) })));
  const kpiText = d.kpis.map(k => `${k.label} ${k.format === 'pct' ? pct(k.value) + '%' : Math.round(k.value * 100) / 100}`
    + (k.change == null ? '' : `（较上期 ${k.changeType === 'pt' ? (k.change * 100).toFixed(1) + ' 个百分点' : pct(k.change) + '%'}）`)).join('；');
  const trendText = d.trend.labels.map((l, i) => `${l}: ${Math.round(d.trend.revenue[i])}`).join(', ');
  const { markdown } = await analyze({
    table: { columns: Object.keys(rows[0] || {}), rows },
    question: '请解读这段时间的经营表现：哪里在增长、哪里在下滑、原因可能是什么、接下来该做什么。',
    directions: ['growth', 'risk', 'action'],
    context: `连锁运动户外零售门店销售数据。统计区间 ${d.period.from} 至 ${d.period.to}（近 ${days} 天），`
      + (d.period.comparable ? `上期为 ${d.period.prevFrom} 至 ${d.period.prevTo}；` : '上期数据不足，无环比；')
      + `范围：${store || '全部门店'}（门店维度始终为全部门店对比）。整体指标：${kpiText}。`
      + `销售额走势（按${d.trend.unit === 'week' ? '周' : '日'}）：${trendText}。`,
  });
  ctx.json({ markdown, period: d.period });
});

app.static('public');
app.listen();

// ---------------- 示例数据（首次启动且表为空时写入；换成真实数据后可删除） ----------------
// 120 天、约 1500 单，固定随机种子生成，每次结果一致。内置的业务故事：
// 周末客流高峰；成都新店持续爬坡；健身器材逐月下滑；运动服饰夏季旺、入秋回落；户外装备随露营季走高；外卖有平台佣金、毛利偏低。
function seedOrders() {
  let s = 218;   // mulberry32 PRNG
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (items, weight) => { const ws = items.map(weight), sum = ws.reduce((a, b) => a + b, 0); let r = rnd() * sum; return items.find((_, i) => (r -= ws[i]) < 0) ?? items.at(-1); };
  const peak = (doy, center, amp) => 1 + amp * Math.cos((2 * Math.PI * (doy - center)) / 365);
  const stores = [['上海静安店', 1.35], ['北京朝阳店', 1.25], ['杭州西湖店', 1.0], ['深圳南山店', 1.1], ['武汉光谷店', 0.8], ['成都春熙路店', 0, 'growing']];
  const categories = [
    { name: '跑步鞋', w: 1.0, cost: 0.52, items: [['轻量竞速跑鞋', 699], ['缓震慢跑鞋', 599], ['越野跑鞋', 799]] },
    { name: '运动服饰', w: 1.3, cost: 0.40, season: [205, 0.45], items: [['速干T恤', 129], ['运动短裤', 149], ['防风外套', 399]] },
    { name: '户外装备', w: 0.7, cost: 0.48, season: [280, 0.6], items: [['双人帐篷', 899], ['登山背包', 459], ['折叠露营椅', 199]] },
    { name: '健身器材', w: 0.9, cost: 0.60, declining: true, items: [['瑜伽垫', 159], ['可调哑铃', 499], ['弹力带套装', 89]] },
    { name: '运动配件', w: 1.1, cost: 0.35, items: [['运动水壶', 79], ['速干毛巾', 59], ['运动袜三双装', 69]] },
  ];
  const DAYS = 120, today = new Date(), rows = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t = (DAYS - 1 - i) / (DAYS - 1);                                       // 0 → 1 across the period
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
    const traffic = [1.5, 0.85, 0.8, 0.85, 0.9, 1.15, 1.6][d.getDay()];          // Sun..Sat
    const n = Math.round(11.8 * traffic * (0.92 + 0.16 * t) * (0.8 + 0.4 * rnd()));
    for (let k = 0; k < n; k++) {
      const [store] = pick(stores, ([, w, g]) => (g ? 0.1 + 1.6 * t : w));
      const cat = pick(categories, c => c.w * (c.season ? peak(doy, ...c.season) : 1) * (c.declining ? 1 - 0.7 * t : 1));
      const [product, price] = pick(cat.items, () => 1);
      const channel = pick(['门店', '小程序', '外卖'], ch => ({ 门店: 0.58, 小程序: 0.24 + 0.08 * t, 外卖: price < 200 ? 0.22 : 0.04 })[ch]);
      const member = rnd() < (channel === '小程序' ? 0.75 : 0.4);
      const quantity = price < 200 ? 1 + (rnd() < 0.4) + (rnd() < 0.15) : 1 + (rnd() < 0.08);
      const amount = Math.round(price * quantity * (member ? 0.95 : 1) * 100) / 100;
      const cost = Math.round((price * quantity * cat.cost + (channel === '外卖' ? amount * 0.18 : 0)) * 100) / 100;   // 外卖含平台佣金
      rows.push({ order_date: day, store, category: cat.name, product, quantity, amount, cost, channel, member });
    }
  }
  return rows;
}
