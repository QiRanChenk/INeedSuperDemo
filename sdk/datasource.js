import fs from 'node:fs';
import path from 'node:path';

/**
 * DataSource contract (implement this to plug in any source):
 *   name: string
 *   kind: 'file' | 'api' | 'database' | ...
 *   async list(): Promise<Array<{ id: string, label: string, meta?: object }>>   // datasets available
 *   async read(id, opts?): Promise<{ columns: string[], rows: object[], meta?: object }>  // tabular data
 */
const registry = new Map();

export const datasources = {
  register(ds) { registry.set(ds.name, ds); return ds; },
  get(name) { const ds = registry.get(name); if (!ds) throw new Error(`datasource not found: ${name}`); return ds; },
  names() { return [...registry.keys()]; },
  async catalog() {
    const out = [];
    for (const ds of registry.values()) {
      let items = [];
      try { items = await ds.list(); } catch (e) { items = [{ id: '__error__', label: e.message }]; }
      out.push({ name: ds.name, kind: ds.kind, items });
    }
    return out;
  },
  /** "source/dataset" string -> table */
  async read(ref, opts) {
    const [name, ...rest] = String(ref).split('/');
    return datasources.get(name).read(rest.join('/'), opts);
  },
};

// ---------- File (CSV / JSON in a directory) ----------
export class FileDataSource {
  constructor(dir, name = 'file') { this.dir = path.resolve(dir); this.name = name; this.kind = 'file'; }
  async list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(f => /\.(csv|json)$/i.test(f)).map(f => ({
      id: f, label: f, meta: { bytes: fs.statSync(path.join(this.dir, f)).size },
    }));
  }
  async read(id) {
    const abs = path.resolve(this.dir, id);
    if (!abs.startsWith(this.dir)) throw new Error('bad path');
    const raw = fs.readFileSync(abs, 'utf8');
    if (/\.json$/i.test(id)) return toTable(JSON.parse(raw));
    return parseCSV(raw);
  }
  /** Save an uploaded file into the directory. */
  async save(id, content) {
    fs.mkdirSync(this.dir, { recursive: true });
    const abs = path.resolve(this.dir, path.basename(id));
    fs.writeFileSync(abs, content);
    return { id: path.basename(id) };
  }
}

// ---------- HTTP API returning JSON ----------
export class ApiDataSource {
  /** endpoints: { [id]: { url, label?, headers?, pick? (path like "data.items") } } */
  constructor(endpoints, name = 'api') { this.endpoints = endpoints; this.name = name; this.kind = 'api'; }
  async list() { return Object.entries(this.endpoints).map(([id, e]) => ({ id, label: e.label || id, meta: { url: e.url } })); }
  async read(id) {
    const e = this.endpoints[id];
    if (!e) throw new Error('unknown endpoint ' + id);
    const res = await fetch(e.url, { headers: e.headers || {} });
    if (!res.ok) throw new Error(`API ${res.status}`);
    let data = await res.json();
    if (e.pick) for (const k of e.pick.split('.')) data = data?.[k];
    return toTable(data);
  }
}

// ---------- SQLite database (sdk/db.js) ----------
export class SqliteDataSource {
  /** db: result of openDb(). Every table becomes a dataset; read(id) accepts a table name or "sql:SELECT ..." */
  /** opts.hide: table names not to list (internal tables); tables starting with "_" are always hidden. */
  constructor(db, name = 'db', { hide = [] } = {}) { this.db = db; this.name = name; this.kind = 'database'; this.hide = new Set(hide); }
  async list() {
    return this.db.tables().filter(t => !t.startsWith('_') && !this.hide.has(t))
      .map(t => ({ id: t, label: t, meta: { rows: this.db.count(t), columns: this.db.columns(t).map(c => c.name) } }));
  }
  async read(id, { limit } = {}) {
    if (String(id).startsWith('sql:')) {
      const { assertReadOnly } = await import('./db.js');
      const rows = this.db.query(assertReadOnly(id.slice(4)));
      return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
    }
    return this.db.readTable(id, { limit });
  }
}
/** Backwards-compatible alias. */
export const DatabaseDataSource = SqliteDataSource;

// ---------- helpers ----------
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter(r => r.some(v => v !== ''));
  if (!clean.length) return { columns: [], rows: [] };
  const columns = clean[0].map(c => c.trim());
  const data = clean.slice(1).map(r => Object.fromEntries(columns.map((c, i) => [c, coerce(r[i] ?? '')])));
  return { columns, rows: data };
}

function coerce(v) {
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function toTable(data) {
  if (Array.isArray(data)) {
    const rows = data.map(r => (typeof r === 'object' && r) ? r : { value: r });
    const columns = [...new Set(rows.flatMap(Object.keys))];
    return { columns, rows };
  }
  if (data && typeof data === 'object') return { columns: ['key', 'value'], rows: Object.entries(data).map(([key, value]) => ({ key, value })) };
  return { columns: ['value'], rows: [{ value: data }] };
}
