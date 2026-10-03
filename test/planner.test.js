import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizePlan, planToMessage } from '../shell/planner.js';
import { feedbackToMessage } from '../shell/feedback.js';
import { checkpointAll } from '../shell/sqlite.js';

test('normalizePlan: tolerates junk, unknown skeleton falls back to blank, caps list sizes', () => {
  const p = normalizePlan({ name: '门店库存预警系统名字特别长特别长', skeleton: 'nope', pages: ['首页', { name: '库存', purpose: '看库存' }, null], data: [{ name: '商品', fields: ['名称*', 3] }], flows: Array(20).fill('x') });
  assert.equal(p.skeleton, 'blank');
  assert.deepEqual(p.pages, [{ name: '首页', purpose: '' }, { name: '库存', purpose: '看库存' }]);
  assert.deepEqual(p.data, [{ name: '商品', fields: ['名称*', '3'] }]);
  assert.equal(p.flows.length, 8);
  assert.ok(p.name.length <= 20);
});

test('planToMessage: sections only when present, always ends with the completion standard', () => {
  const m = planToMessage({ skeleton: 'admin', summary: '管库存', pages: [{ name: '库存', purpose: '看' }], flows: ['录入'] }, '库存工具');
  assert.match(m, /当前起步骨架：管理后台/);
  assert.match(m, /## 页面\n- 库存：看/);
  assert.doesNotMatch(m, /## 数据/);
  assert.match(m, /device=mobile/);
});

test('feedbackToMessage: numbered, page + author + phone hint', () => {
  const m = feedbackToMessage([{ text: '加筛选\n按日期', page: '/orders', name: '李四', viewport: '390x844' }, { text: '字太小', page: '/' }]);
  assert.match(m, /1\. 加筛选 按日期（页面 \/orders）——李四（手机上提的）/);
  assert.match(m, /2\. 字太小$/);
});

test('checkpointAll folds WAL writes into the main database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-db-'));
  const f = path.join(dir, 'app.db');
  const db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'a\')');
  // keep the writer open (like a running project) and copy the .db alone: without a checkpoint the row is missing
  assert.deepEqual(checkpointAll(dir), [f]);
  fs.copyFileSync(f, path.join(dir, 'copy.db'));
  const copy = new DatabaseSync(path.join(dir, 'copy.db'));
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM t').get().n, 1);
  copy.close(); db.close();
});
