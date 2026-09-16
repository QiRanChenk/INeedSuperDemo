import { createApp, llm, openDb, datasources, FileDataSource, ApiDataSource, SqliteDataSource, analyze, DEFAULT_DIRECTIONS, assertReadOnly } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || 'Demo';

// ---- database: real persistent SQLite storage (data/app.db). ALL stored data goes here. ----
const db = openDb('data/app.db');
db.ensureTable('analyses', 'id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, question TEXT, directions TEXT, markdown TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP');

// ---- data sources: file (data/) + database tables + example public API ----
const files = datasources.register(new FileDataSource('data'));
datasources.register(new SqliteDataSource(db));
// seed: load bundled CSV files into database tables once (skip if table exists)
for (const f of await files.list()) if (/\.csv$/i.test(f.id)) db.importTable(f.id.replace(/\.csv$/i, ''), await files.read(f.id));
datasources.register(new ApiDataSource({
  'world-population': { label: '示例 API：各国人口 (restcountries)', url: 'https://restcountries.com/v3.1/all?fields=name,region,population,area',
    pick: undefined },
}));

const app = createApp();

app.get('api/info', (req, res, ctx) => ctx.json({ project: PROJECT, llmConfigured: llm.isConfigured(), directions: DEFAULT_DIRECTIONS }));

app.get('api/datasources', async (req, res, ctx) => ctx.json(await datasources.catalog()));

app.get('api/data', async (req, res, ctx) => {
  const table = await datasources.read(ctx.query.ref);
  const limit = Number(ctx.query.limit || 50);
  ctx.json({ columns: table.columns, total: table.rows.length, rows: table.rows.slice(0, limit) });
});

// upload a CSV/JSON as raw text: POST api/upload?name=xxx.csv  -> saved to data/ AND imported into a database table
app.post('api/upload', async (req, res, ctx) => {
  const name = String(ctx.query.name || 'upload.csv');
  if (!/\.(csv|json)$/i.test(name)) return ctx.json({ error: '仅支持 .csv / .json' }, 400);
  await files.save(name, typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body));
  const table = name.replace(/\.(csv|json)$/i, '').replace(/[^\w\u4e00-\u9fa5]+/g, '_');
  const imported = db.importTable(table, await files.read(name), { mode: 'replace' });
  ctx.json({ ok: true, ref: `db/${table}`, imported });
});

// read-only SQL over the project database (SELECT only)
app.post('api/query', async (req, res, ctx) => {
  const sql = assertReadOnly(ctx.body?.sql || '');
  const rows = db.query(sql);
  ctx.json({ columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, 500), total: rows.length });
});

// analysis history (persisted in database)
app.get('api/analyses', (req, res, ctx) => ctx.json(db.query('SELECT id, ref, question, directions, created_at, substr(markdown, 1, 120) AS preview FROM analyses ORDER BY id DESC LIMIT 50')));
app.get('api/analyses/:id', (req, res, ctx) => { const r = db.get('SELECT * FROM analyses WHERE id = ?', [ctx.params.id]); r ? ctx.json(r) : ctx.json({ error: 'not found' }, 404); });

app.post('api/analyze', async (req, res, ctx) => {
  const { ref, question, directions, context } = ctx.body || {};
  if (!ref) return ctx.json({ error: 'ref required' }, 400);
  if (!llm.isConfigured()) return ctx.json({ error: 'LLM 未配置，请在壳设置中填写 API Key' }, 400);
  const table = await datasources.read(ref);
  // restcountries returns nested name objects; flatten for readability
  for (const r of table.rows) if (r.name && typeof r.name === 'object') r.name = r.name.common;
  const result = await analyze({ table, question, directions, context });
  const { lastInsertRowid } = db.insert('analyses', { ref, question: question || '', directions: JSON.stringify(directions || []), markdown: result.markdown });
  ctx.json({ ...result, id: lastInsertRowid });
});

app.static('public');
app.listen();
