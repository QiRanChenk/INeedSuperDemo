import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from '../shell/auth.js';
import { previewKey, demoPreview } from '../shell/proxy.js';

const req = (method, headers = {}) => ({ method, headers: { host: 'localhost:3999', ...headers } });

test('shell refuses writes that the browser marks as cross-origin (e.g. a demo on the other port)', () => {
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'same-site', origin: 'http://localhost:4000' }))?.status, 403);
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))?.status, 403);
  assert.equal(checkRequest(req('POST', { origin: 'null' }))?.status, 403);
  assert.equal(checkRequest(req('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3999' })), null);
  assert.equal(checkRequest(req('GET', { 'sec-fetch-site': 'same-site' })), null); // reads are blocked by CORS instead
});

test('demo-origin preview needs the project key', () => {
  const run = (url, cookie) => {
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, send() { return this; }, appendHeader(k, v) { this.headers[k] = v; }, redirect(c) { this.statusCode = c; } };
    demoPreview({ originalUrl: url, headers: cookie ? { cookie } : {}, method: 'GET', on() {} }, res);
    return res;
  };
  assert.equal(run('/p/demo/').statusCode, 403);
  assert.equal(run('/p/demo/?_sdk=wrongwrongwrongwrongwron').statusCode, 403);
  assert.equal(run('/p/other/', `sdpk=${previewKey('demo')}`).statusCode, 403); // a key opens its own project only
  assert.match(String(run(`/p/demo/?_sdk=${previewKey('demo')}`).headers['set-cookie']), /^sdpk=.*Path=\/p\/demo\/; HttpOnly/);
});
