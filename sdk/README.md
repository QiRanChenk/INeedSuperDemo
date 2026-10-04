# sdk/ — 项目内置 SDK（零依赖，Node ≥ 18）

`import { createApp, llm, openDb, datasources, FileDataSource, ApiDataSource, SqliteDataSource, analyze, DEFAULT_DIRECTIONS, parseCSV } from './sdk/index.js'`

## HTTP：`createApp()`
```js
const app = createApp();
app.get('api/items/:id', (req, res, ctx) => ctx.json({ id: ctx.params.id, q: ctx.query }));
app.post('api/items', (req, res, ctx) => ctx.json({ received: ctx.body }));   // body 已按 content-type 解析
app.static('public');                     // 静态目录，/ 映射 public/index.html
app.listen();                             // 端口取 process.env.PORT
```
ctx 提供：`params`、`query`、`body`、`json(data, status)`、`text(s, status)`、`html(s, status)`。（也兼容 Express 写法：`req.params` / `req.query` / `req.body`、`res.status(404).json({...})`。）

## LLM：`llm`
- `await llm.complete(prompt, { system, temperature, onUsage })` → string
- `await llm.completeJSON(prompt, opts)` → 解析后的对象
- `await llm.chat(messages, { tools, temperature, maxTokens, signal, onUsage })` → `{ message, usage, ms, model, id, finishReason }`
  - `message`：assistant message（OpenAI 格式，含 `content` / `tool_calls`），可直接 push 回 messages 继续多轮
  - `usage`：`{ input, output, cached, total, raw }`（服务端未返回时为 null）；`ms` 为本次耗时
- `onUsage(usage, result)`：任一调用完成后回调，用于在 complete / completeJSON 中拿到 token 用量
- `llm.stats()` → 本进程累计 `{ input, output, cached, total, calls, ms }`；`llm.resetStats()` 清零
- `llm.isConfigured()` → boolean
```js
const { message, usage } = await llm.chat([{ role: 'user', content: '你好' }]);
console.log(message.content, usage?.total);
let used; const text = await llm.complete('总结这段话', { onUsage: u => { used = u; } });
```
配置来自环境变量 `SUPERDEMO_LLM_BASE_URL / SUPERDEMO_LLM_API_KEY / SUPERDEMO_LLM_MODEL`（壳自动注入；独立部署时写 .env 或系统环境）。

## 数据库：`openDb()`（SQLite，Node 内置 `node:sqlite`，零依赖）
**凡是需要保存数据的功能（表单提交、用户、订单、配置、上传的数据集……）必须存进这个数据库，禁止用内存数组或 JSON 文件充当存储。**
```js
const db = openDb('data/app.db');                       // 文件持久化，重启不丢
db.ensureTable('orders', 'id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, amount REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP');
db.insert('orders', { customer: '张三', amount: 99.5 });   // -> { changes, lastInsertRowid }
db.insertMany('orders', rows);                           // 事务批量插入
db.query('SELECT * FROM orders WHERE amount > ? ORDER BY id DESC', [50]);   // -> 对象数组
db.get('SELECT COUNT(*) AS n FROM orders');              // -> 单行
db.run('UPDATE orders SET amount = ? WHERE id = ?', [120, 1]);
db.transaction(() => { ... });
db.importTable('sales', parseCSV(text), { mode: 'skip' | 'replace' | 'append' });  // CSV/JSON 表 -> 数据表
db.readTable('sales');                                   // -> { columns, rows }，可直接喂给 analyze()
db.tables(); db.columns('sales'); db.count('sales');
```
`assertReadOnly(sql)` 校验只读 SELECT，用于暴露给用户/AI 的查询接口。

## 数据源：`datasources`
统一契约：`{ name, kind, list() -> [{id,label}], read(id) -> { columns, rows } }`
```js
datasources.register(new FileDataSource('data'));                 // data/ 下的 .csv/.json
datasources.register(new ApiDataSource({ users: { url: 'https://...', pick: 'data.list' } }));
datasources.register(new SqliteDataSource(db, 'db', { hide: ['analyses'] }));  // 每张表 = 一个数据集（hide 隐藏内部表，_ 开头自动隐藏）；read('sql:SELECT ...') 只读 SQL
await datasources.catalog();          // 所有源及其数据集
await datasources.read('file/sales.csv');   // "源名/数据集id"
await datasources.read('db/sales');         // 数据库表
```
自定义源（如 Postgres/MySQL/第三方 API）：任何实现上述契约的对象都可 `register`。

## 洞察：`analyze()`
```js
const table = await datasources.read('file/sales.csv');
const { markdown, profile, usage } = await analyze({
  table, question: '哪个地区最值得加大投入？',
  directions: ['growth', 'risk', 'action'],   // 见 DEFAULT_DIRECTIONS，或传 {id,label,hint}
  context: '这是一家饮料公司的季度销售数据',
});   // usage: 本次 LLM 调用的 token 用量（同 llm.chat）
```
`summarizeTable(table)` 纯 JS 统计画像（行数、列类型、min/max/mean、分组求和、月度趋势），analyze 内部把画像而非原始行喂给 LLM。

## 前端组件库：`_sd/sd.css` + `_sd/sd.js`（SDK 自带，经 `_sd/` 提供，零依赖）
页面统一用它，保证电脑和手机都好看。普通 HTML 元素（input / select / textarea / button / table）引入后即有样式。
```html
<link rel="stylesheet" href="_sd/sd.css">          <!-- 相对路径，放在自己的 style.css 之前 -->
<script src="_sd/sd.js"></script>                   <!-- 放在自己的 app.js 之前，提供全局 sd -->
```
主题色等变量写在 body 上：`body { --sd-brand: #0f9d58; --sd-brand-soft: #e6f4ea; }`（写在 :root 会被设计语言覆盖）。可调变量：--sd-bg / --sd-card / --sd-ink / --sd-muted / --sd-line / --sd-radius / --sd-btn-radius / --sd-font-head / --sd-font-num / --sd-h1 / --sd-pad / --sd-gap / --sd-topbar-bg / --sd-topbar-ink。

**设计语言（body 上加一个 class，改变字体、形状、密度、表面、顶栏，不只是颜色）**
| class | 适合 | 特征 |
|---|---|---|
| （不加）| 通用内部工具 | 干净、蓝色、中等圆角 |
| `sd-look-industrial` | 工厂、仓储、物流、巡检、工地 | 深色顶栏、高对比、方角、大按钮、等宽数字、琥珀色 |
| `sd-look-warm` | 酒店、餐饮、家装、美业、教育、面向消费者的服务 | 暖米底色、衬线标题、大圆角、宽松留白、陶土色 |
| `sd-look-bold` | 活动、促销、健身、年轻品牌、报名 | 品牌色顶栏、大字号粗标题、色块、指标卡色条 |
| `sd-look-editorial` | 律所、咨询、投顾、高端品牌、出版 | 白底细线、衬线大标题、无阴影、大留白、黑白克制 |
| `sd-look-compact` | 财务、运营后台、分析师、数据很多的系统 | 小字号、紧凑行距、小控件、青绿色 |

**布局原型（可与任一设计语言组合）**
- 顶栏型（默认）：`.sd-topbar` + `.sd-page`
- 侧边栏应用：`<body class="sd-layout-sidebar sd-look-…"><aside class="sd-sidebar"><div class="sd-brand">…</div><nav class="sd-nav">…</nav></aside><main class="sd-main"><div class="sd-page">…</div></main>` —— 页面多、长时间使用的后台
- 手机优先 + 底部标签栏：`<nav class="sd-tabbar"><a class="active" href="./">🏠<span>首页</span></a>…</nav>`（只在手机显示，手机上自动隐藏顶栏导航）—— 一线人员、前台、现场巡检
- 首屏横幅：`<section class="sd-hero"><h1>…</h1><p>…</p><div class="sd-actions">…</div></section>` —— 面向客户的页面、报名、报价、活动
- 状态墙：`<div class="sd-board"><div class="sd-tile ok|warn|danger|off"><div class="sd-tile-label">…</div><div class="sd-tile-value">…</div></div></div>` —— 设备、工位、房间、桌台等一屏看全的监控

**设计方向要求**：按方案里的设计方向选设计语言和布局，并做出行业专属的界面元素（如签到台的大号输入键盘、巡检的设备状态墙、报价的可打印报价单、餐饮的桌台图）——**颜色是最后一步，不是唯一的差异**。不要每个项目都是「标题 + 4 张指标卡 + 表格」。

**布局 class**：`sd-topbar`（顶栏，含 `sd-brand` 品牌 + `sd-brand-logo` 方块图标、`sd-nav` 导航、`sd-topbar-end` 右侧区）→ `sd-page`（内容容器，`sd-page-narrow` 窄版）→ `sd-page-head`（h1 + p 说明 + `sd-actions` 按钮组）；`sd-card`（`sd-card-head` 标题行，`sd-card-flush` 无内边距，适合放表格）；`sd-grid`（自适应卡片网格）/`sd-grid-2`/`sd-grid-3`（手机自动单列）；`sd-row`、`sd-stack`、`sd-spacer`。
**组件 class**：按钮 `sd-btn-primary` / `sd-btn-danger` / `sd-btn-ghost` / `sd-btn-sm` / `sd-btn-block`（type=submit 默认主按钮）；指标卡 `sd-stats` > `sd-stat` > `sd-stat-label` + `sd-stat-value` + `sd-stat-delta up|down`；表单 `sd-form`（两列，手机单列）> `sd-field`（label + 控件 + `sd-hint`），`sd-field-full` 占整行，必填 label 加 `sd-req`（会自动显示红色 *，文字里不要再写 *），`sd-form-actions` 按钮行；筛选栏 `sd-toolbar`，搜索框 `<div class="sd-search"><input></div>`；状态标签 `sd-tag ok|warn|danger|info|brand`；页签 `sd-tabs`、分段 `sd-seg`（子元素 `.active`）；空状态 `sd-empty`；列表 `sd-list`；`sd-muted` / `sd-small` / `sd-hide-mobile` / `sd-show-mobile`。

**sd.js（全局 `sd`）**
- `await sd.api('api/items')`、`sd.api('api/items', { body: {...} })`（自动 POST + JSON）、`{ method: 'PUT', body }`；失败抛出 Error(服务端 error 字段)
- `sd.toast('已保存')`、`sd.toast('失败：…', 'error')`
- `if (await sd.confirm('确定删除「张三」？', { danger: true, okText: '删除' })) …`
- `const v = await sd.formModal({ title: '新增客户', fields: [{ name: 'name', label: '姓名', required: true }, { name: 'level', label: '等级', type: 'select', options: ['A','B','C'] }, { name: 'amount', label: '金额', type: 'number' }, { name: 'note', label: '备注', type: 'textarea' }], values: row, onSubmit: v => sd.api('api/customers', { body: v }) })` → 校验必填、提交失败时在弹窗内提示；取消返回 null。字段 type：text / number / email / tel / date / datetime-local / select / textarea / checkbox，可选 placeholder / hint / min / max / step / pattern（配 title 作为错误提示，如手机号 `pattern: '1\\d{10}', title: '请输入 11 位手机号'`）/ maxlength / inputmode / full；必填下拉默认带「请选择」空选项
- `sd.table('#list', { columns: [{ key: 'name', label: '姓名' }, { key: 'amount', label: '金额', num: true, render: r => sd.fmt.money(r.amount) }, { key: 'status', label: '状态', render: r => sd.tag(r.status, r.status === '已完成' ? 'ok' : 'warn') }, { key: 'note', label: '备注', mobile: false }], rows, empty: '还没有客户，点右上角新增', actions: [{ text: '编辑', onClick: r => … }, { text: '删除', danger: true, onClick: r => … }], onRowClick: r => … })` → 手机上自动变成卡片（次要列加 `mobile: false` 在手机上隐藏，每张卡片保持 4–6 行；主列加 `primary: true` 作为卡片标题）；render 返回 HTML，**用户输入的文字务必 `sd.esc()`**
- `sd.pager('#pager', { page, pageSize, total, onChange: p => … })`、`sd.tabs('#tabs', v => …)`（子元素带 data-value）
- `sd.chart.bar('#c', { labels: ['1月','2月'], values: [120, 98] })`、排行榜用横向条 `sd.chart.bar(el, { labels, values }, { horizontal: true })`、`sd.chart.line(el, { labels, series: [{ name: '收入', values }, { name: '成本', values }] })`、`sd.chart.pie(el, { labels, values })`；可选 `{ height, format: v => sd.fmt.money(v) }`；多系列共用一根纵轴，量级差很大的指标（金额和单数）分开画
- `sd.fmt.money(1234.5)` → ¥1,234.50、`fmt.num`、`fmt.pct(0.123)` → 12.3%（传比例）、`fmt.date`、`fmt.datetime`、`fmt.ago`（3 分钟前）
- `sd.modal({ title, content, actions })`、`sd.busy(btn, () => sd.api(...))`（按钮转圈防重复点）、`sd.esc`、`sd.$` / `sd.$$`、`sd.debounce(fn, 300)`、`sd.formData(form)`、`sd.validate(form)`

**观感要求**：首屏要有业务标题和一句说明；列表/看板必须有示例数据（启动时若表为空，插入 15–40 条贴近业务、有真实感的中文数据：人名、公司、地址、金额、日期分布合理、状态多样），不要出现"测试1""aaa"；所有空状态写清楚下一步做什么；手机宽度下不能横向滚动。
