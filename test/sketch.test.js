import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSketch } from '../shell/sketch.js';

test('cleanSketch strips fences, scripts, handlers and javascript: urls', () => {
  const out = cleanSketch('```html\n<!doctype html><html><body onload="x()"><script>alert(1)</script><a href="javascript:alert(2)" onclick=\'y()\'>a</a><img src=x onerror=z()></body></html>\n```');
  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(!/script|onload|onclick|onerror|javascript:/i.test(out), out);
});

test('cleanSketch drops leading prose before the document', () => {
  assert.ok(cleanSketch('Here it is:\n<html><body>hi</body></html>').startsWith('<html>'));
});
