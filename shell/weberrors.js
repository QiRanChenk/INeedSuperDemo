// Front-end errors reported by preview pages (script injected by the proxy) -> the project's run log as [web] lines,
// where the agent sees them. Repeats within 10 s are dropped.
import { readProject } from './registry.js';
import * as runner from './runner.js';

const recent = new Map(); // `${id}\n${message}` -> ts
export function recordClientError(id, b = {}) {
  if (!readProject(id)) return;
  const msg = `[${String(b.kind || 'error').slice(0, 20)}] ${String(b.message || '').slice(0, 1500).replace(/\s*\n\s*/g, ' ⏎ ')}${b.page && b.page !== '/' ? ` (页面 ${String(b.page).slice(0, 200)})` : ''}`;
  const key = id + '\n' + msg, now = Date.now();
  if (now - (recent.get(key) || 0) < 10_000) return;
  recent.set(key, now);
  if (recent.size > 500) for (const [k, t] of recent) if (now - t > 60_000) recent.delete(k);
  runner.log(id, 'web', msg);
}
