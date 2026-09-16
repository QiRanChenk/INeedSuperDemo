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
ctx 提供：`params`、`query`、`body`、`json(data, status)`、`text(s, status)`、`html(s, status)`。

## LLM：`llm`
- `await llm.complete(prompt, { system, temperature })` → string
- `await llm.completeJSON(prompt, opts)` → 解析后的对象
- `await llm.chat(messages, { tools, temperature })` → assistant message（OpenAI 格式）
- `llm.isConfigured()` → boolean
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
datasources.register(new SqliteDataSource(db));                   // 数据库每张表 = 一个数据集；read('sql:SELECT ...') 支持只读 SQL
await datasources.catalog();          // 所有源及其数据集
await datasources.read('file/sales.csv');   // "源名/数据集id"
await datasources.read('db/sales');         // 数据库表
```
自定义源（如 Postgres/MySQL/第三方 API）：任何实现上述契约的对象都可 `register`。

## 洞察：`analyze()`
```js
const table = await datasources.read('file/sales.csv');
const { markdown, profile } = await analyze({
  table, question: '哪个地区最值得加大投入？',
  directions: ['growth', 'risk', 'action'],   // 见 DEFAULT_DIRECTIONS，或传 {id,label,hint}
  context: '这是一家饮料公司的季度销售数据',
});
```
`summarizeTable(table)` 纯 JS 统计画像（行数、列类型、min/max/mean、分组求和、月度趋势），analyze 内部把画像而非原始行喂给 LLM。
