import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../shell/compare.js';

test('judge: no data, thin sample, strong / mixed / weak signals', () => {
  assert.equal(judge({ visitors: 0, reacted: 0 }).signal, 'none');
  assert.equal(judge({ visitors: 3, reacted: 2, score: 0.9 }).signal, 'thin');
  assert.equal(judge({ visitors: 7, reacted: 7, score: 0.61, contacts: 3 }).signal, 'strong');
  assert.equal(judge({ visitors: 8, reacted: 8, score: 0.3 }).signal, 'mixed');
  assert.equal(judge({ visitors: 8, reacted: 8, score: 0.21 }).signal, 'weak');
  assert.match(judge({ visitors: 2, reacted: 0 }).next, /再找 3 位/);
});
