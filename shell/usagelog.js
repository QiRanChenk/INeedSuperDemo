// Append-only, shell-wide token usage log: one line per LLM call. Survives session/project deletion.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECTS_DIR } from './config.js';

const LOG = path.join(DATA_DIR, 'usage-log.jsonl');

/** entry: { p: projectId, s: sessionId, i: input, o: output, c: cached, t?: epoch ms } */
export function logUsage(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const e = { t: entry.t || Date.now(), p: entry.p || '', s: entry.s || '', i: entry.i | 0, o: entry.o | 0, c: entry.c | 0 };
  fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
  return e;
}

export function readLog(from = 0, to = Infinity) {
  if (!fs.existsSync(LOG)) return [];
  const out = [];
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.t >= from && e.t <= to) out.push(e); } catch {}
  }
  return out;
}

const agg = list => list.reduce((a, e) => { a.input += e.i; a.output += e.o; a.cached += e.c; a.total += e.i + e.o; a.calls++; return a; },
  { input: 0, output: 0, cached: 0, total: 0, calls: 0 });

/** today (server-local midnight) and all-time totals. */
export function summary() {
  const all = readLog();
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  return { today: agg(all.filter(e => e.t >= start)), all: agg(all), first: all.length ? Math.min(...all.map(e => e.t)) : null };
}

/** One-time import of historic per-message usage from every project's session files. */
export function backfillIfNeeded() {
  if (fs.existsSync(LOG) || !fs.existsSync(PROJECTS_DIR)) return 0;
  const entries = [];
  for (const pid of fs.readdirSync(PROJECTS_DIR)) {
    const meta = path.join(PROJECTS_DIR, pid, '.superdemo');
    const files = [];
    const sdir = path.join(meta, 'sessions');
    if (fs.existsSync(sdir)) for (const f of fs.readdirSync(sdir)) if (f.endsWith('.json')) files.push([f.replace(/\.json$/, ''), path.join(sdir, f)]);
    if (fs.existsSync(path.join(meta, 'history.json'))) files.push(['default', path.join(meta, 'history.json')]);
    for (const [sid, file] of files) {
      try {
        for (const m of JSON.parse(fs.readFileSync(file, 'utf8')))
          if (m.role === 'assistant' && m.usage && m.ts) entries.push({ t: m.ts, p: pid, s: sid, i: m.usage.input | 0, o: m.usage.output | 0, c: m.usage.cached | 0 });
      } catch {}
    }
  }
  entries.sort((a, b) => a.t - b.t);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  return entries.length;
}
