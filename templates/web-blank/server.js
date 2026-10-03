// Blank skeleton: one page + the SDK. Add tables with db.ensureTable and routes with app.get / app.post.
import { createApp, openDb, llm } from './sdk/index.js';

const PROJECT = process.env.SUPERDEMO_PROJECT_NAME || 'Demo';
const db = openDb('data/app.db'); // all stored data goes into this database
db.ensureTable('notes', 'id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP');

const app = createApp();
app.get('api/info', (req, res, ctx) => ctx.json({ project: PROJECT, llmConfigured: llm.isConfigured() }));
app.get('api/notes', (req, res, ctx) => ctx.json(db.query('SELECT * FROM notes ORDER BY id DESC LIMIT 50')));
app.post('api/notes', (req, res, ctx) => {
  const text = String(ctx.body?.text || '').trim();
  if (!text) return ctx.json({ error: '请输入内容' }, 400);
  ctx.json({ id: db.insert('notes', { text }).lastInsertRowid });
});
app.static('public');
app.listen();
