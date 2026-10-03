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
