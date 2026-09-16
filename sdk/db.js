// Real persistent storage for projects: SQLite via Node's built-in `node:sqlite` (Node >= 22.13, zero dependencies).
// Every B/S project that stores data MUST use this instead of in-memory arrays or JSON files.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(file = 'data/app.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const db = {
    raw,
    file,
    /** Run DDL / multiple statements. */
    exec: sql => raw.exec(sql),
    /** SELECT -> array of plain objects. */
    query: (sql, params = []) => raw.prepare(sql).all(...params).map(r => ({ ...r })),
    /** SELECT -> first row or undefined. */
    get: (sql, params = []) => { const r = raw.prepare(sql).get(...params); return r ? { ...r } : undefined; },
    /** INSERT / UPDATE / DELETE -> { changes, lastInsertRowid }. */
    run: (sql, params = []) => { const r = raw.prepare(sql).run(...params); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    /** Wrap fn in a transaction. */
    transaction(fn) { raw.exec('BEGIN'); try { const out = fn(db); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    /** CREATE TABLE IF NOT EXISTS name (columnsSql). */
    ensureTable: (name, columnsSql) => raw.exec(`CREATE TABLE IF NOT EXISTS ${ident(name)} (${columnsSql})`),
    tables: () => raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name),
    columns: table => raw.prepare(`PRAGMA table_info(${ident(table)})`).all().map(r => ({ name: r.name, type: r.type, pk: !!r.pk })),
    count: table => Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}`).get().n),
    /** Insert one object; keys = columns. */
    insert(table, obj) {
      const keys = Object.keys(obj);
      return db.run(`INSERT INTO ${ident(table)} (${keys.map(ident).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => norm(obj[k])));
    },
    /** Bulk insert rows (array of objects) inside one transaction. */
    insertMany(table, rows) {
      if (!rows.length) return 0;
      const keys = [...new Set(rows.flatMap(Object.keys))];
      const stmt = raw.prepare(`INSERT INTO ${ident(table)} (${keys.map(ident).join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
      return db.transaction(() => { for (const r of rows) stmt.run(...keys.map(k => norm(r[k]))); return rows.length; });
    },
    /**
     * Create table from a { columns, rows } table (e.g. parsed CSV) and load rows. Column types inferred.
     * mode: 'skip' (default: do nothing if table exists) | 'replace' | 'append'
     */
    importTable(table, { columns, rows }, { mode = 'skip' } = {}) {
      const exists = db.tables().includes(table);
      if (exists && mode === 'skip') return { table, imported: 0, existed: true };
      if (exists && mode === 'replace') raw.exec(`DROP TABLE ${ident(table)}`);
      if (!exists || mode === 'replace') {
        const defs = columns.map(c => `${ident(c)} ${inferType(rows.map(r => r[c]))}`);
        raw.exec(`CREATE TABLE ${ident(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs.join(', ')})`);
      }
      const n = db.insertMany(table, rows.map(r => Object.fromEntries(columns.map(c => [c, r[c]]))));
      return { table, imported: n, existed: exists };
    },
    /** Whole table as { columns, rows } (for datasources / analyze). */
    readTable(table, { limit = 100000, where = '', params = [] } = {}) {
      const rows = db.query(`SELECT * FROM ${ident(table)} ${where ? 'WHERE ' + where : ''} LIMIT ?`, [...params, limit]);
      return { columns: db.columns(table).map(c => c.name), rows };
    },
    close: () => raw.close(),
  };
  return db;
}

/** Only allow read-only SELECT / WITH statements (for user- or AI-facing query endpoints). */
export function assertReadOnly(sql) {
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s) || /;/.test(s)) throw new Error('only a single SELECT statement is allowed');
  if (/\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum)\b/i.test(s)) throw new Error('read-only query violates policy');
  return s;
}

export const ident = name => {
  if (!/^[A-Za-z_][A-Za-z0-9_一-龥]*$/.test(name)) return '"' + String(name).replace(/"/g, '""') + '"';
  return '"' + name + '"';
};
const norm = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
function inferType(vals) {
  const vs = vals.filter(v => v !== null && v !== undefined && v !== '');
  if (!vs.length) return 'TEXT';
  if (vs.every(v => typeof v === 'number')) return vs.every(Number.isInteger) ? 'INTEGER' : 'REAL';
  return 'TEXT';
}
