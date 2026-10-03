// Visitor feedback left on shared demos (/s/<token>/ shows a floating "提意见" button). Stored per project as JSON lines.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './registry.js';

const file = id => path.join(projectDir(id), '.superdemo', 'feedback.jsonl');
export const STATUSES = ['new', 'sent', 'done'];

function readAll(id) {
  try { return fs.readFileSync(file(id), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function writeAll(id, list) { fs.mkdirSync(path.dirname(file(id)), { recursive: true }); fs.writeFileSync(file(id), list.map(x => JSON.stringify(x)).join('\n') + (list.length ? '\n' : '')); }

export function listFeedback(id) { return readAll(id).reverse(); }
export const countNew = id => readAll(id).filter(f => f.status === 'new').length;

export function addFeedback(id, { text, name, page, viewport, share }) {
  const f = {
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(), status: 'new',
    text: String(text || '').trim().slice(0, 2000),
    name: String(name || '').trim().slice(0, 40),
    page: String(page || '').slice(0, 200),
    viewport: String(viewport || '').slice(0, 20),
    share: share ? { token: share.token, label: share.label || '' } : null,
  };
  if (!f.text) throw new Error('请写下你的建议');
  fs.mkdirSync(path.dirname(file(id)), { recursive: true });
  fs.appendFileSync(file(id), JSON.stringify(f) + '\n');
  return f;
}

export function updateFeedback(id, ids, status) {
  if (!STATUSES.includes(status)) throw new Error('bad status');
  const set = new Set([].concat(ids));
  const list = readAll(id);
  for (const f of list) if (set.has(f.id)) f.status = status;
  writeAll(id, list);
  return list.reverse();
}

export function deleteFeedback(id, ids) {
  const set = new Set([].concat(ids));
  writeAll(id, readAll(id).filter(f => !set.has(f.id)));
  return listFeedback(id);
}

/** Selected feedback as an instruction for the agent. */
export function feedbackToMessage(items) {
  const lines = items.map((f, i) => `${i + 1}. ${f.text.replace(/\s*\n\s*/g, ' ')}${f.page && f.page !== '/' ? `（页面 ${f.page}）` : ''}${f.name ? `——${f.name}` : ''}${f.viewport && /^(\d+)x/.test(f.viewport) && parseInt(f.viewport) < 600 ? '（手机上提的）' : ''}`);
  return `以下是别人试用这个 Demo 时留下的反馈。请逐条判断：合理的直接改好；不合理或与现有设计冲突的，说明原因并给出建议；改完用 page_view 检查（手机上提的要用 device="mobile" 看）。最后逐条说明处理结果。\n\n${lines.join('\n')}`;
}
