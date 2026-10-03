import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../shell/agent.js';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const big = n => 'x'.repeat(n);

test('older turns are compacted, the latest two kept in full', () => {
  const h = [];
  for (let t = 0; t < 3; t++) {
    h.push({ role: 'user', content: 'turn ' + t });
    h.push({ role: 'assistant', content: '', tool_calls: [call('c' + t, 'read_file', { path: 'a.js' })] });
    h.push({ role: 'tool', tool_call_id: 'c' + t, content: big(500) });
    h.push({ role: 'assistant', content: 'done' });
  }
  const { messages, compacted } = compactHistory(h);
  assert.equal(compacted, 1);
  assert.match(messages[2].content, /旧结果已省略/);
  assert.equal(messages[6].content.length, 500);
  assert.equal(messages[10].content.length, 500);
});

test('long turn: stale reads and big outputs before the bucketed cut are collapsed; recent ones stay', () => {
  const h = [{ role: 'user', content: 'go' }];
  h.push({ role: 'assistant', content: '', tool_calls: [call('r1', 'read_file', { path: './a.js' })] });
  h.push({ role: 'tool', tool_call_id: 'r1', content: big(400) });            // superseded by the edit below
  h.push({ role: 'assistant', content: '', tool_calls: [call('e1', 'edit_file', { path: 'a.js', old_string: big(300), new_string: 'y' })] });
  h.push({ role: 'tool', tool_call_id: 'e1', content: 'OK' });
  h.push({ role: 'assistant', content: '', tool_calls: [call('r2', 'read_file', { path: 'b.js' })] });
  h.push({ role: 'tool', tool_call_id: 'r2', content: big(400) });            // not superseded, small -> kept
  for (let i = 0; i < 60; i++) {
    h.push({ role: 'assistant', content: '', tool_calls: [call('g' + i, 'grep', { pattern: 'x' })] });
    h.push({ role: 'tool', tool_call_id: 'g' + i, content: big(2000) });
  }
  const { messages } = compactHistory(h);
  assert.match(messages[2].content, /已过期/);
  assert.match(JSON.parse(messages[3].tool_calls[0].function.arguments).old_string, /已省略 300/);
  assert.equal(messages[6].content.length, 400);
  assert.match(messages[8].content, /旧结果已省略/);                      // big grep output before the cut
  assert.equal(messages.at(-1).content.length, 2000);                        // recent stays full
});

test('cut moves in buckets, so the prefix is stable while a turn grows', () => {
  const mk = n => { const h = [{ role: 'user', content: 'go' }]; for (let i = 0; i < n; i++) { h.push({ role: 'assistant', content: '', tool_calls: [call('g' + i, 'grep', { pattern: 'x' })] }); h.push({ role: 'tool', tool_call_id: 'g' + i, content: big(2000) }); } return h; };
  const a = compactHistory(mk(30)).messages, b = compactHistory(mk(31)).messages;
  assert.deepEqual(b.slice(0, a.length), a);
});

test('internal fields never reach the model', () => {
  const { messages } = compactHistory([{ role: 'user', content: 'hi', ts: 1 }, { role: 'assistant', content: null, reasoning: 'r', usage: {}, ts: 2 }]);
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }]);
});

test('screenshots: only the latest two in kept turns carry an image marker; the image field never leaks', () => {
  const h = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 3; i++) {
    h.push({ role: 'assistant', content: '', tool_calls: [call('p' + i, 'page_view', {})] });
    h.push({ role: 'tool', tool_call_id: 'p' + i, content: 'snapshot' });
    h.push({ role: 'user', system: true, content: '[系统] 页面截图', image: `s${i}.jpg` });
  }
  const { messages } = compactHistory(h);
  assert.deepEqual(messages.filter(m => m._image).map(m => m._image), ['s1.jpg', 's2.jpg']);
  assert.ok(messages.every(m => !('image' in m)));
});
