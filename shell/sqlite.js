// SQLite in WAL mode keeps recent writes in <db>-wal until a checkpoint. Before copying a project's data (export,
// demo-data snapshot, duplicate) fold the WAL into the main file so the copy is complete. Safe while the project runs.
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

/** Checkpoint every SQLite database under dir (recursively, skipping node_modules). Returns the files checkpointed. */
export function checkpointAll(dir) {
  const done = [];
  if (!DatabaseSync || !fs.existsSync(dir)) return done;
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== '.superdemo') walk(f); continue; }
      if (!fs.existsSync(f + '-wal')) continue;
      try { const db = new DatabaseSync(f); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); done.push(f); } catch {}
    }
  })(dir);
  return done;
}
