// 管理后台（增删改查）骨架 — 示例实体：客户。
// To adapt to another entity (订单 / 商品 / 工单 …): change TABLE, FIELDS, SEARCH, the stats route and seed().
// Keep public/app.js FIELDS in sync with the FIELDS here.
import { createApp, openDb } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || '客户管理';

// ---- entity definition: ONE list drives the table schema, validation, insert and update ----
const TABLE = 'customers';
const FIELDS = [
  { name: 'name', label: '客户姓名', required: true, max: 50 },
  { name: 'company', label: '公司', max: 100 },
  { name: 'phone', label: '电话', pattern: /^[\d\-+ ()]{5,20}$/ },
  { name: 'email', label: '邮箱', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { name: 'city', label: '城市', max: 30 },
  { name: 'level', label: '客户等级', options: ['A', 'B', 'C'], default: 'B' },
  { name: 'status', label: '跟进状态', options: ['潜在', '跟进中', '已成交', '已流失'], default: '潜在' },
  { name: 'owner', label: '负责人', max: 30 },
  { name: 'amount', label: '预计金额', type: 'number', min: 0 },
  { name: 'note', label: '备注', max: 1000 },
];
const SEARCH = ['name', 'company', 'phone'];                       // columns matched by the search box (q)
const FILTERS = ['status', 'level'];                               // exact-match filters from the toolbar
const SORTABLE = ['id', 'created_at', 'updated_at', 'amount', 'name'];

// ---- storage: real SQLite file data/app.db (columns generated from FIELDS) ----
const db = openDb('data/app.db');
db.ensureTable(TABLE, ['id INTEGER PRIMARY KEY AUTOINCREMENT',
  ...FIELDS.map(f => `${f.name} ${f.type === 'number' ? 'REAL' : 'TEXT'}${f.required ? ' NOT NULL' : ''}`),
  'created_at TEXT', 'updated_at TEXT'].join(', '));

// local time "YYYY-MM-DD HH:MM:SS" (stored as text, sorts correctly)
const stamp = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

/** Validate + normalise a request body against FIELDS. partial=true (update) only checks fields that are present. */
function clean(body, partial = false) {
  const out = {};
  for (const f of FIELDS) {
    if (partial && !(f.name in (body || {}))) continue;
    let v = body?.[f.name];
    v = v == null ? '' : String(v).trim();
    if (!v) {
      if (f.required) throw httpError(`请填写${f.label}`);
      out[f.name] = partial ? null : (f.default ?? null);
      continue;
    }
    if (f.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw httpError(`${f.label}必须是数字`);
      if (f.min != null && v < f.min) throw httpError(`${f.label}不能小于 ${f.min}`);
    } else {
      if (f.max && v.length > f.max) throw httpError(`${f.label}不能超过 ${f.max} 个字`);
      if (f.options && !f.options.includes(v)) throw httpError(`${f.label}只能是：${f.options.join(' / ')}`);
      if (f.pattern && !f.pattern.test(v)) throw httpError(`${f.label}格式不正确`);
    }
    out[f.name] = v;
  }
  return out;
}
const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Build WHERE from query params (q / status / level) — shared by list and export. */
function where(query) {
  const parts = [], params = [];
  const q = String(query.q || '').trim();
  if (q) { parts.push('(' + SEARCH.map(c => `${c} LIKE ?`).join(' OR ') + ')'); params.push(...SEARCH.map(() => `%${q}%`)); }
  for (const k of FILTERS) if (query[k]) { parts.push(`${k} = ?`); params.push(String(query[k])); }
  return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params };
}
// sort=amount (asc) | -amount (desc); default newest first
function orderBy(sort = '-created_at') {
  const desc = String(sort).startsWith('-'), col = String(sort).replace(/^-/, '');
  return SORTABLE.includes(col) ? `ORDER BY ${col} ${desc ? 'DESC' : 'ASC'}, id DESC` : 'ORDER BY created_at DESC, id DESC';
}

const app = createApp();
// wrap handlers so thrown httpError(...) becomes { error } with its status
const safe = fn => async (req, res, ctx) => { try { await fn(req, res, ctx); } catch (e) { if (!e.status) throw e; ctx.json({ error: e.message }, e.status); } };

app.get('api/info', (req, res, ctx) => ctx.json({ project: PROJECT }));

// list: ?q=&status=&level=&page=1&pageSize=10&sort=-created_at -> { rows, total }
app.get(`api/${TABLE}`, (req, res, ctx) => {
  const w = where(ctx.query);
  const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize) || 10));
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const total = db.get(`SELECT COUNT(*) AS n FROM ${TABLE} ${w.sql}`, w.params).n;
  const rows = db.query(`SELECT * FROM ${TABLE} ${w.sql} ${orderBy(ctx.query.sort)} LIMIT ? OFFSET ?`, [...w.params, pageSize, (page - 1) * pageSize]);
  ctx.json({ rows, total });
});

// KPI cards (registered before :id routes)
app.get(`api/${TABLE}/stats`, (req, res, ctx) => {
  const byStatus = Object.fromEntries(FIELDS.find(f => f.name === 'status').options.map(s => [s, 0]));
  for (const r of db.query(`SELECT status, COUNT(*) AS n FROM ${TABLE} GROUP BY status`)) byStatus[r.status] = r.n;
  const monthStart = stamp().slice(0, 8) + '01';
  ctx.json({
    total: db.count(TABLE),
    byStatus,
    wonAmount: db.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM ${TABLE} WHERE status = '已成交'`).s,
    newThisMonth: db.get(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE created_at >= ?`, [monthStart]).n,
  });
});

// export current filter as CSV (BOM so Excel shows Chinese correctly)
app.get(`api/${TABLE}/export.csv`, (req, res, ctx) => {
  const w = where(ctx.query);
  const rows = db.query(`SELECT * FROM ${TABLE} ${w.sql} ${orderBy(ctx.query.sort)}`, w.params);
  const cols = [...FIELDS.map(f => [f.name, f.label]), ['created_at', '创建时间']];
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map(c => c[1]), ...rows.map(r => cols.map(c => r[c[0]]))].map(r => r.map(cell).join(',')).join('\r\n');
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(`客户列表-${stamp().slice(0, 10)}.csv`)}` });
  res.end('\uFEFF' + csv);
});

app.post(`api/${TABLE}`, safe((req, res, ctx) => {
  const now = stamp();
  const { lastInsertRowid } = db.insert(TABLE, { ...clean(ctx.body), created_at: now, updated_at: now });
  ctx.json(db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [lastInsertRowid]), 201);
}));

app.put(`api/${TABLE}/:id`, safe((req, res, ctx) => {
  const data = clean(ctx.body, true);
  const keys = Object.keys(data);
  if (!keys.length) throw httpError('没有需要保存的内容');
  const { changes } = db.run(`UPDATE ${TABLE} SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...keys.map(k => data[k]), stamp(), ctx.params.id]);
  if (!changes) throw httpError('记录不存在或已被删除', 404);
  ctx.json(db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, [ctx.params.id]));
}));

app.delete(`api/${TABLE}/:id`, safe((req, res, ctx) => {
  if (!db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [ctx.params.id]).changes) throw httpError('记录不存在或已被删除', 404);
  ctx.json({ ok: true });
}));

// ---- sample data: inserted once when the table is empty (replace with the new entity's realistic rows) ----
function seed() {
  if (db.count(TABLE)) return;
  const people = [
    ['王建国', '杭州云栖智能科技有限公司', '杭州', 'wangjianguo@yunqi-tech.cn'], ['李晓燕', '上海浦江供应链管理有限公司', '上海', 'lixy@pujiang-scm.com'],
    ['张伟', '深圳前海星河电子有限公司', '深圳', 'zhangwei@xinghe-elec.com'], ['刘芳', '北京中关村数智信息技术有限公司', '北京', 'liufang@shuzhi.com.cn'],
    ['陈志强', '成都锦城餐饮管理有限公司', '成都', ''], ['杨静', '苏州恒信精密机械有限公司', '苏州', 'yangjing@hengxin-jm.com'],
    ['赵磊', '广州天河美途旅游服务有限公司', '广州', 'zhaolei@meitu-travel.cn'], ['黄丽娟', '南京紫金教育咨询有限公司', '南京', ''],
    ['周涛', '武汉光谷康瑞生物医药有限公司', '武汉', 'zhoutao@kangrui-bio.com'], ['吴敏', '西安曲江文化传媒有限公司', '西安', 'wumin@qujiang-media.cn'],
    ['徐海峰', '宁波港通物流有限公司', '宁波', 'xuhf@gangtong56.com'], ['孙雪梅', '厦门鹭岛海产贸易有限公司', '厦门', ''],
    ['马俊', '青岛海润新材料有限公司', '青岛', 'majun@hairun-nm.com'], ['朱婷婷', '长沙湘江建设工程有限公司', '长沙', 'zhutt@xjjs.com.cn'],
    ['胡斌', '合肥科创新能源有限公司', '合肥', 'hubin@kechuang-ne.com'], ['郭晓东', '重庆山城汽车配件有限公司', '重庆', ''],
    ['何佳怡', '天津滨海国际贸易有限公司', '天津', 'hejiayi@binhai-trade.com'], ['高翔', '郑州中原粮油集团有限公司', '郑州', 'gaoxiang@zygrain.com'],
    ['林慧', '东莞松湖家具制造有限公司', '东莞', 'linhui@songhu-home.com'], ['罗明轩', '佛山南海陶瓷有限公司', '佛山', ''],
    ['郑雅琴', '无锡太湖医疗器械有限公司', '无锡', 'zhengyq@taihu-med.com'], ['梁国华', '福州闽江茶业有限公司', '福州', 'lianggh@minjiang-tea.cn'],
    ['谢文博', '济南泉城软件有限公司', '济南', 'xiewb@quancheng-soft.com'], ['宋雨桐', '昆明滇池花卉有限公司', '昆明', ''],
    ['唐志勇', '大连星海船舶服务有限公司', '大连', 'tangzy@xinghai-ship.com'], ['韩冰', '沈阳盛京装备制造有限公司', '沈阳', 'hanbing@shengjing-zb.com'],
    ['冯晓蕾', '南昌赣江农业科技有限公司', '南昌', 'fengxl@ganjiang-agri.cn'], ['邓凯', '温州瓯越鞋业有限公司', '温州', ''],
    ['曹颖', '珠海横琴跨境电商有限公司', '珠海', 'caoying@hengqin-ec.com'], ['彭立新', '贵阳数谷云计算有限公司', '贵阳', 'penglx@shugu-cloud.cn'],
  ];
  const owners = ['陈晨', '林悦', '周航', '许诺'];
  const statuses = ['潜在', '跟进中', '跟进中', '已成交', '已成交', '潜在', '已流失', '跟进中'];
  const notes = {
    潜在: ['展会上留的名片，待首次电话沟通', '官网留言咨询，对年度服务包感兴趣', '老客户转介绍，下周约拜访'],
    跟进中: ['已发送报价单，等待采购审批', '对方关注售后响应时效，需补充服务承诺', '年底有预算，建议月底前再跟进', '已完成产品演示，技术负责人认可'],
    已成交: ['已签署年度框架协议，首付款已到账', '合同已回签，安排实施团队进场', '续约成功，追加两个分公司'],
    已流失: ['预算被砍，项目暂缓', '选择了价格更低的竞品'],
  };
  let s = 20241001; const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);   // deterministic
  const rows = people.map(([name, company, city, email], i) => {
    const status = statuses[i % statuses.length];
    const created = new Date(Date.now() - (0.2 + rand() * 89) * 86400000); created.setHours(9 + Math.floor(rand() * 9), Math.floor(rand() * 60));
    const updated = new Date(+created + rand() * (Date.now() - created) * 0.6);   // some time after creation
    const list = notes[status];
    return {
      name, company, city, email,
      phone: `1${[3, 5, 8, 7, 9][i % 5]}${String(Math.floor(rand() * 1e9)).padStart(9, '0')}`,
      level: rand() < 0.25 ? 'A' : rand() < 0.6 ? 'B' : 'C', status, owner: owners[i % owners.length],
      amount: Math.round((2 + rand() * 78) * 10) * 1000, note: rand() < 0.75 ? list[i % list.length] : '',
      created_at: stamp(created), updated_at: stamp(updated),
    };
  });
  db.insertMany(TABLE, rows);
}
seed();

app.static('public');
app.listen();
