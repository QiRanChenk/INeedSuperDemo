import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdit, readText, grepFiles, checkSyntax } from '../shell/tools.js';

test('applyEdit: unique match is replaced', () => {
  const r = applyEdit('a = 1;\nb = 2;\n', 'b = 2;', 'b = 3;');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'a = 1;\nb = 3;\n');
});

test('applyEdit: missing / ambiguous / identical are errors, never silent no-ops', () => {
  assert.match(applyEdit('x', 'y', 'z').message, /未找到/);
  assert.match(applyEdit('  foo', 'foo  ', 'bar').message, /首尾空白/);
  assert.match(applyEdit('aa', 'a', 'b').message, /出现 2 次/);
  assert.match(applyEdit('a', 'a', 'a').message, /相同/);
  assert.match(applyEdit('a', '', 'b').message, /不能为空/);
});

test('applyEdit: replace_all and $-patterns in new_string are literal', () => {
  assert.equal(applyEdit('a a a', 'a', 'b', true).content, 'b b b');
  assert.equal(applyEdit('x', 'x', "$& $1 $'").content, "$& $1 $'");
});

test('readText: line ranges and truncation hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
  assert.equal(readText(f, 'a.txt', { offset: 3, limit: 2 }), '[a.txt 第 3-4 行 / 共 10 行]\nline3\nline4');
  assert.match(readText(f, 'a.txt', { offset: 20 }), /只有 10 行/);
  fs.writeFileSync(f, 'x\n'.repeat(40_000));
  assert.match(readText(f, 'a.txt'), /offset\/limit 分段读取/);
});

test('grepFiles: finds matches with line numbers, skips sdk/node_modules, honours glob', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  fs.mkdirSync(path.join(dir, 'lib')); fs.mkdirSync(path.join(dir, 'sdk')); fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'lib/a.js'), 'const x = 1;\nfunction hello() {}\n');
  fs.writeFileSync(path.join(dir, 'lib/a.css'), '.hello {}\n');
  fs.writeFileSync(path.join(dir, 'sdk/b.js'), 'function hello() {}\n');
  fs.writeFileSync(path.join(dir, 'node_modules/c.js'), 'function hello() {}\n');
  assert.equal(grepFiles(dir, { pattern: 'hello', glob: '*.js' }), 'lib/a.js:2: function hello() {}');
  assert.equal(grepFiles(dir, { pattern: 'HELLO', ignore_case: true }).split('\n').length, 2);
  assert.equal(grepFiles(dir, { pattern: 'nope' }), '(无匹配)');
  assert.match(grepFiles(dir, { pattern: '(' }), /正则无效/);
  assert.match(grepFiles(dir, { pattern: 'x', path: '../' }), /escapes/);
});

test('checkSyntax: accepts browser scripts and ESM, reports real errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const w = (n, src) => { fs.writeFileSync(path.join(dir, n), src); return path.join(dir, n); };
  assert.equal(await checkSyntax(w('browser.js', 'const static = 1; window.x = static;')), null); // sloppy-only syntax
  assert.equal(await checkSyntax(w('esm.js', "import fs from 'node:fs';\nexport const a = await Promise.resolve(fs);")), null);
  assert.match(await checkSyntax(w('bad.js', 'function (')), /SyntaxError/);
  assert.equal(await checkSyntax(w('x.css', '{{{')), null);
});
