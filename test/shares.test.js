import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recordEvent, shareStats } from '../shell/shares.js';
import { DATA_DIR } from '../shell/config.js';

test('shareStats separates views, actions and visible time', () => {
  const tok = 'test' + Date.now().toString(36);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    recordEvent(tok, 'v1', undefined, { p: '/' });
    recordEvent(tok, 'v2', undefined, { p: '/' });
    recordEvent(tok, 'v2', undefined, { p: '/orders.html' });
    recordEvent(tok, 'v1', 'a', { a: 'POST /api/items' });
    recordEvent(tok, 'v1', 'a', { a: 'PUT /api/items/12' });
    recordEvent(tok, 'v1', 'd', { ms: 30000, p: '/' });
    recordEvent(tok, 'v2', 'd', { ms: 5000, p: '/' });
    recordEvent(tok, 'v2', 'd', { ms: 5000, p: '/orders.html' });
    const st = shareStats(tok);
    assert.equal(st.views, 3);
    assert.equal(st.visitors, 2);
    assert.equal(st.actors, 1);
    assert.deepEqual(st.actions.map(a => a.action).sort(), ['POST /api/items', 'PUT /api/items/:id']);
    assert.equal(st.timed, 2);
    assert.equal(st.medianMs, 30000); // per visitor: v1 30 s, v2 10 s
  } finally {
    const f = path.join(DATA_DIR, 'share-views.jsonl');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(l => l && !l.includes(tok)).join('\n') + '\n');
  }
});

test('normPublicUrl keeps http(s) origins (+ path), drops the rest', async () => {
  const { normPublicUrl } = await import('../shell/config.js');
  assert.equal(normPublicUrl('https://demo.example.com/'), 'https://demo.example.com');
  assert.equal(normPublicUrl('http://1.2.3.4:18788'), 'http://1.2.3.4:18788');
  assert.equal(normPublicUrl('https://x.com/sd/'), 'https://x.com/sd');
  assert.equal(normPublicUrl('demo.example.com'), '');
  assert.equal(normPublicUrl('javascript:alert(1)'), '');
});
