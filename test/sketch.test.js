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

test('cleanSketch closes a sketch cut off by the output limit', () => {
  const out = cleanSketch('<!doctype html><html><body><div class="a">x</div><div class="b" sty');
  assert.match(out, /被截断[\s\S]*<\/body><\/html>$/);
  assert.ok(!out.includes('sty\n'));
});

test('cleanSketch drops prose after </html> without calling it truncated', () => {
  const out = cleanSketch('<html><body>x</body></html>\n\n以上是草图，说明：……');
  assert.equal(out, '<html><body>x</body></html>');
});
