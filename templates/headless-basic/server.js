import { createApp, llm, openDb, datasources, FileDataSource, SqliteDataSource, analyze } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || 'Service';
const db = openDb('data/app.db');          // real persistent storage; use db.ensureTable / insert / query
datasources.register(new FileDataSource('data'));
datasources.register(new SqliteDataSource(db));

const app = createApp();
app.get('api/health', (req, res, ctx) => ctx.json({ ok: true, project: PROJECT, llm: llm.isConfigured(), time: new Date().toISOString() }));
app.get('api/datasources', async (req, res, ctx) => ctx.json(await datasources.catalog()));
app.post('api/ask', async (req, res, ctx) => {
  const { prompt, system } = ctx.body || {};
  if (!prompt) return ctx.json({ error: 'prompt required' }, 400);
  ctx.json({ answer: await llm.complete(prompt, { system }) });
});
app.post('api/analyze', async (req, res, ctx) => {
  const { ref, question, directions, context } = ctx.body || {};
  ctx.json(await analyze({ table: await datasources.read(ref), question, directions, context }));
});
app.get('/', (req, res, ctx) => ctx.json({ service: PROJECT, endpoints: ['GET api/health', 'GET api/datasources', 'POST api/ask', 'POST api/analyze'] }));
app.listen();
