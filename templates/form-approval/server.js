import { createApp, openDb } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || '活动报名';

// ---- 业务配置：活动信息与场次（前端从 api/info 读取，不要在页面里再写一份） ----
const EVENT = {
  title: '2026 智慧零售创新峰会',
  intro: '与 300+ 零售品牌、渠道商和技术服务商一起，探讨门店数字化、会员运营与供应链协同的最新实践。',
  time: '2026年10月18日 – 19日',
  place: '上海 · 国际会议中心 3 楼',
};
const SESSIONS = ['10月18日 上午 · 主论坛', '10月18日 下午 · 数字化门店分论坛', '10月19日 上午 · 供应链协同分论坛', '10月19日 下午 · 品牌闭门交流会'];
const STATUSES = ['待审核', '已通过', '已驳回'];

// ---- 表单字段：服务端唯一定义处，驱动校验、入库和导出 ----
// 改成其它表单（请假申请、采购申请……）时：改这里 + public/fields.js 的 FIELDS（两边 name 一致），再同步下面的建表语句。
const FIELDS = [
  { name: 'name', label: '姓名', required: true, len: 20 },
  { name: 'phone', label: '手机号', required: true, pattern: /^1\d{10}$/, message: '请填写 11 位手机号' },
  { name: 'company', label: '单位名称', required: true, len: 50 },
  { name: 'title', label: '职务', len: 30 },
  { name: 'email', label: '邮箱', len: 60, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: '邮箱格式不正确' },
  { name: 'attendees', label: '参会人数', type: 'number', required: true, min: 1, max: 5 },
  { name: 'session', label: '参加场次', required: true, options: SESSIONS },
  { name: 'needs', label: '备注 / 需求', len: 500 },
];

const db = openDb('data/app.db');
db.ensureTable('submissions', `id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE,
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, company TEXT, title TEXT, attendees INTEGER DEFAULT 1, session TEXT, needs TEXT,
  status TEXT NOT NULL DEFAULT '待审核', reviewer TEXT, review_note TEXT, reviewed_at TEXT, created_at TEXT NOT NULL`);

// ---- helpers ----
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const makeCode = (id, createdAt) => `BM${createdAt.slice(0, 10).replace(/-/g, '')}-${pad(id, 4)}`;   // e.g. BM20261003-0042

/** Insert one submission and give it a readable code; returns the stored row. (sync calls, so insert + update can't interleave) */
function addSubmission(row) {
  const created_at = row.created_at || stamp();
  const { lastInsertRowid: id } = db.insert('submissions', { ...row, created_at });
  db.run('UPDATE submissions SET code = ? WHERE id = ?', [makeCode(id, created_at), id]);
  return db.get('SELECT * FROM submissions WHERE id = ?', [id]);
}

/** Validate a submitted body against FIELDS -> { row } or { error }. */
function validate(body = {}) {
  const row = {};
  for (const f of FIELDS) {
    const v = String(body[f.name] ?? '').trim();
    if (!v) { if (f.required) return { error: `请填写${f.label}` }; row[f.name] = f.type === 'number' ? null : ''; continue; }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < f.min || n > f.max) return { error: `${f.label}请填写 ${f.min}–${f.max} 之间的整数` };
      row[f.name] = n; continue;
    }
    if (f.len && v.length > f.len) return { error: `${f.label}不能超过 ${f.len} 个字` };
    if (f.options && !f.options.includes(v)) return { error: `请选择有效的${f.label}` };
    if (f.pattern && !f.pattern.test(v)) return { error: f.message };
    row[f.name] = v;
  }
  return { row };
}

/** WHERE clause for the admin list / export: status tab + keyword. */
function filters({ status, q }) {
  const where = [], params = [];
  if (STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(name LIKE ? OR phone LIKE ? OR company LIKE ? OR code LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// ---- seed: realistic sample data on first start ----
if (db.count('submissions') === 0) {
  // [姓名, 单位, 职务, 场次序号, 人数, 需求, 几天前, 状态, 审核意见]
  const seed = [
    ['陈思远', '盒马鲜生', '数字化运营总监', 0, 2, '需要增值税专用发票', 29, '已通过', '欢迎参会，请携带身份证签到'],
    ['林晓彤', '永辉超市股份有限公司', '会员运营经理', 1, 1, '', 28, '已通过', ''],
    ['赵国栋', '杭州云析科技有限公司', 'CEO', 3, 1, '希望安排与品牌方的对接', 27, '已驳回', '闭门交流会仅面向品牌方，建议改报 10月18日 上午主论坛'],
    ['周婉清', '名创优品', '门店拓展负责人', 1, 3, '', 26, '已通过', ''],
    ['吴海峰', '苏宁易购', '供应链规划经理', 2, 2, '一人素食', 24, '已通过', '欢迎参会，素食需求已登记'],
    ['郑雅文', '屈臣氏中国', '品牌市场经理', 3, 1, '', 23, '已通过', ''],
    ['孙浩然', '上海鼎沃信息技术有限公司', '销售总监', 0, 5, '', 22, '已驳回', '本单位在该场次已有 3 人报名，名额已满，请调整人数后重新报名'],
    ['黄嘉怡', '百果园', '数字化项目经理', 1, 2, '需要停车位 1 个', 21, '已通过', '停车位已预留，凭车牌入场'],
    ['马俊杰', '物美集团', 'IT 副总裁', 0, 1, '', 19, '已通过', ''],
    ['刘欣然', '完美日记', '私域运营主管', 1, 2, '', 18, '已通过', ''],
    ['何振宇', '京东到家', '商家合作经理', 2, 1, '', 16, '已通过', ''],
    ['许静怡', '良品铺子', '会员中心负责人', 3, 2, '希望会后获取演讲资料', 15, '已通过', '资料将在会后统一发送至邮箱'],
    ['冯子轩', '个人', '自由职业', 0, 1, '', 14, '已驳回', '单位信息无法核实，请补充所在单位后重新报名'],
    ['唐雨萱', '泡泡玛特', '渠道运营经理', 1, 1, '', 12, '已通过', ''],
    ['曹立新', '华润万家', '采购总监', 2, 3, '三人同行，需开具一张发票', 11, '已通过', ''],
    ['邓佳琪', '三只松鼠', '电商运营经理', 0, 2, '', 9, '已通过', ''],
    ['彭博文', '深圳智铺科技有限公司', '产品经理', 2, 1, '', 8, '已驳回', '本场次名额已满，可改报 10月18日 下午分论坛'],
    ['蒋梦洁', '钱大妈', '门店运营经理', 1, 2, '', 6, '已通过', ''],
    ['韩子墨', '元气森林', '渠道数字化负责人', 2, 1, '需要英文同传耳机', 5, '待审核', ''],
    ['杨若曦', '喜茶', '会员增长经理', 3, 1, '', 4, '待审核', ''],
    ['朱晨阳', '美宜佳', '信息中心经理', 0, 3, '', 3, '待审核', ''],
    ['秦思雨', '奈雪的茶', '数字化产品经理', 1, 1, '', 2, '待审核', ''],
    ['沈国华', '联华超市', '物流总监', 2, 2, '需要停车位 1 个', 1, '待审核', ''],
    ['袁诗涵', '钟薛高', '品牌合作经理', 3, 1, '', 0, '待审核', ''],
    ['范志强', '上海优链供应链管理有限公司', '总经理', 0, 2, '', 0, '待审核', ''],
  ];
  const pinyin = ['chensy', 'linxt', 'zhaogd', 'zhouwq', 'wuhf', 'zhengyw', 'sunhr', 'huangjy', 'majj', 'liuxr', 'hezy', 'xujy', 'fengzx', 'tangyx', 'caolx', 'dengjq', 'pengbw', 'jiangmj', 'hanzm', 'yangrx', 'zhucy', 'qinsy', 'shengh', 'yuansh', 'fanzq'];
  db.transaction(() => seed.forEach(([name, company, title, s, attendees, needs, daysAgo, status, note], i) => {
    const created = new Date(Date.now() - daysAgo * 86400e3 - ((i * 47) % 300 + 5) * 60e3);
    addSubmission({
      name, company, title, attendees, needs, status, session: SESSIONS[s],
      phone: `1${[3, 5, 8, 7, 9][i % 5]}${1e8 + (i * 37919 + 2468013) * 7919 % 9e8}`,
      email: company === '个人' ? '' : `${pinyin[i]}@example.com`,
      created_at: stamp(created),
      ...(status !== '待审核' && { reviewer: i % 3 ? '王敏' : '李娜', review_note: note, reviewed_at: stamp(new Date(created.getTime() + (3 + i % 20) * 3600e3)) }),
    });
  }));
}

const app = createApp();

app.get('api/info', (req, res, ctx) => ctx.json({ project: PROJECT, event: EVENT, sessions: SESSIONS, statuses: STATUSES }));

// 提交报名（公开）
app.post('api/submissions', (req, res, ctx) => {
  const { row, error } = validate(ctx.body);
  if (error) return ctx.json({ error }, 400);
  if (db.get("SELECT id FROM submissions WHERE phone = ? AND session = ? AND status != '已驳回'", [row.phone, row.session]))
    return ctx.json({ error: `该手机号已报名「${row.session}」，请勿重复提交；可凭报名编号查询进度` }, 400);
  const saved = addSubmission(row);
  ctx.json({ code: saved.code, status: saved.status, session: saved.session });
});

// 报名人查询进度（公开）：编号 + 手机号，只返回进度相关字段
app.get('api/submissions/lookup', (req, res, ctx) => {
  const code = String(ctx.query.code || '').trim().toUpperCase(), phone = String(ctx.query.phone || '').trim();
  if (!code || !phone) return ctx.json({ error: '请填写报名编号和手机号' }, 400);
  const r = db.get('SELECT code, name, session, status, review_note, reviewed_at, created_at FROM submissions WHERE code = ? AND phone = ?', [code, phone]);
  r ? ctx.json(r) : ctx.json({ error: '没有找到对应的报名记录，请核对编号和手机号' }, 404);
});

// ---- 审核台 ----
app.get('api/submissions', (req, res, ctx) => {
  const page = Math.max(1, Number(ctx.query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize) || 10));
  const { sql, params } = filters(ctx.query);
  const total = db.get(`SELECT COUNT(*) AS n FROM submissions ${sql}`, params).n;
  const rows = db.query(`SELECT * FROM submissions ${sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  ctx.json({ rows, total });
});

app.get('api/submissions/stats', (req, res, ctx) => {
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of db.query('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status')) byStatus[r.status] = r.n;
  const today = db.get('SELECT COUNT(*) AS n FROM submissions WHERE created_at >= ?', [stamp().slice(0, 10)]).n;
  const counts = db.query(`SELECT session, COUNT(*) AS total, SUM(status = '已通过') AS approved,
    COALESCE(SUM(CASE WHEN status = '已通过' THEN attendees END), 0) AS people FROM submissions GROUP BY session`);
  const bySession = SESSIONS.map(s => ({ session: s, total: 0, approved: 0, people: 0, ...counts.find(c => c.session === s) }));
  ctx.json({ byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0), today, bySession });
});

app.get('api/submissions/export.csv', (req, res, ctx) => {
  const { sql, params } = filters(ctx.query);
  const rows = db.query(`SELECT * FROM submissions ${sql} ORDER BY created_at DESC, id DESC`, params);
  const cols = [['code', '报名编号'], ...FIELDS.map(f => [f.name, f.label]), ['status', '审核状态'], ['reviewer', '审核人'], ['review_note', '审核意见'], ['reviewed_at', '审核时间'], ['created_at', '提交时间']];
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map(c => c[1]), ...rows.map(r => cols.map(c => r[c[0]]))].map(line => line.map(cell).join(',')).join('\r\n');
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`报名名单-${stamp().slice(0, 10)}.csv`)}` });
  res.end('\ufeff' + csv);   // BOM: Excel 直接打开不乱码
});

app.post('api/submissions/:id/review', (req, res, ctx) => {
  const { status, note = '', reviewer = '' } = ctx.body || {};
  if (!['已通过', '已驳回'].includes(status)) return ctx.json({ error: '请选择通过或驳回' }, 400);
  if (status === '已驳回' && !String(note).trim()) return ctx.json({ error: '驳回时请填写原因，方便报名人了解情况' }, 400);
  const { changes } = db.run('UPDATE submissions SET status = ?, review_note = ?, reviewer = ?, reviewed_at = ? WHERE id = ?',
    [status, String(note).trim(), String(reviewer).trim() || '审核员', stamp(), ctx.params.id]);
  if (!changes) return ctx.json({ error: '这条报名记录不存在或已被删除' }, 404);
  ctx.json(db.get('SELECT * FROM submissions WHERE id = ?', [ctx.params.id]));
});

app.static('public');
app.listen();
