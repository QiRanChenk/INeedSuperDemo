// SuperDemo project SDK - zero dependencies, Node >= 18.
// This directory is copied into every project so the project stays independently deployable.
export { createApp, serveStatic } from './http.js';
export { llm } from './llm.js';
export { datasources, FileDataSource, ApiDataSource, SqliteDataSource, DatabaseDataSource, parseCSV, toTable } from './datasource.js';
export { openDb, assertReadOnly } from './db.js';
export { analyze, summarizeTable, DEFAULT_DIRECTIONS } from './insights.js';
