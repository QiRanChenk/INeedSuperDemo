import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectReporter } from '../shell/proxy.js';

test('reporter goes first inside <head>, before project scripts', () => {
  const out = injectReporter('<!doctype html><html><head><script src="app.js"></script></head></html>', 'demo');
  assert.ok(out.indexOf('client-errors') < out.indexOf('app.js'));
  assert.match(out, /^<!doctype html><html><head><script>/);
  assert.match(out, /\/api\/projects\/demo\/client-errors/);
});

test('pages without <head> still get the reporter', () => {
  assert.match(injectReporter('<!DOCTYPE html><p>x', 'a'), /^<!DOCTYPE html><script>/);
  assert.match(injectReporter('<p>x', 'a'), /^<script>/);
});

test('tour: steps keep relative pages only; visitor script escapes text and parses', async () => {
  const { normalizeTour, tourScript } = await import('../shell/tour.js');
  const t = normalizeTour({ title: '体验', steps: [{ text: '看看', page: 'https://evil.example/x' }, { text: '<img onerror=1>', page: '/dashboard.html' }, 'x'] });
  assert.deepEqual(t.steps.map(s => s.page), ['', 'dashboard.html', '']);
  const js = tourScript(t, 'T'.repeat(20));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('<img'));
});

test('inputSnippet summarises a visitor submission and masks phone numbers', async () => {
  const { inputSnippet } = await import('../shell/proxy.js');
  assert.equal(inputSnippet('{"name":"青菜","price":1.2,"phone":"13812345678","pic":"data:image/png;base64,xx"}'), 'name=青菜 price=1.2 phone=138****78');
  assert.equal(inputSnippet('a=1&b=%E4%BD%A0'), 'a=1 b=你');
  assert.equal(inputSnippet(''), '');
});

test('hasMarkup screens visitor writes (json, form, multipart) but lets plain text and raster images through', async () => {
  const { hasMarkup } = await import('../shell/proxy.js');
  const J = 'application/json';
  assert.equal(hasMarkup('{"name":"青菜","note":"价格<5 元也行"}', J), false);
  assert.equal(hasMarkup('{"name":"<img src=x onerror=alert(1)>"}', J), true);
  assert.equal(hasMarkup('{"name":"\\u003cscript\\u003e"}', J), true);           // escaped in JSON, decoded before the check
  assert.equal(hasMarkup('{"a":{"b":["javascript:alert(1)"]}}', J), true);
  assert.equal(hasMarkup('name=%3Csvg%20onload%3Dx%3E', 'application/x-www-form-urlencoded'), true);
  assert.equal(hasMarkup('name=%E9%9D%92%E8%8F%9C', 'application/x-www-form-urlencoded'), false);
  const mp = (head, body) => `--B\r\n${head}\r\n\r\n${body}\r\n--B--`;
  assert.equal(hasMarkup(mp('Content-Disposition: form-data; name="f"; filename="a.png"\r\nContent-Type: image/png', '\x89PNG<a bc>'), 'multipart/form-data; boundary=B'), false);
  assert.equal(hasMarkup(mp('Content-Disposition: form-data; name="f"; filename="a.svg"\r\nContent-Type: image/svg+xml', '<svg onload=x>'), 'multipart/form-data; boundary=B'), true);
});

test('inputSnippet masks phone numbers written with spaces or dashes', async () => {
  const { inputSnippet } = await import('../shell/proxy.js');
  assert.equal(inputSnippet('{"tel":"138-1234-5678","t2":"138 1234 5678","n":"2024"}'), 'tel=138****78 t2=138****78 n=2024');
});
