// File / search / HTTP helpers behind the agent's tools. Kept free of agent state so they are easy to test.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';

const READ_LIMIT = 60_000;

/** Whole file, or lines [offset, offset+limit) (1-based) with a header so the model knows where it is. */
export function readText(abs, rel, { offset, limit, max = READ_LIMIT } = {}) {
  if (!fs.existsSync(abs)) return `ERROR: 文件不存在 ${rel}`;
  if (fs.statSync(abs).isDirectory()) return `ERROR: ${rel} 是目录，请用 list_files`;
  const txt = fs.readFileSync(abs, 'utf8');
  if (!offset && !limit) {
    if (txt.length <= max) return txt;
    const shown = txt.slice(0, max), n = shown.split('\n').length;
    return `${shown}\n...(文件过长已截断：共 ${txt.split('\n').length} 行，只显示到约第 ${n} 行；用 offset/limit 分段读取，或先 grep 定位)`;
  }
  const lines = txt.split('\n');
  const start = Math.max(1, offset | 0 || 1), end = Math.min(lines.length, start + Math.max(1, limit | 0 || 200) - 1);
  if (start > lines.length) return `ERROR: ${rel} 只有 ${lines.length} 行`;
  return `[${rel} 第 ${start}-${end} 行 / 共 ${lines.length} 行]\n` + lines.slice(start - 1, end).join('\n');
}

/**
 * Exact search-and-replace. Fails loudly when old_string is missing or ambiguous so a silent no-op never happens.
 * Returns { ok, message, content? } — content is the new file text when ok.
 */
export function applyEdit(text, oldStr, newStr, replaceAll = false) {
  if (typeof oldStr !== 'string' || !oldStr) return { ok: false, message: 'ERROR: old_string 不能为空（新建文件请用 write_file）' };
  if (oldStr === newStr) return { ok: false, message: 'ERROR: old_string 与 new_string 相同，无需修改' };
  let count = 0;
  for (let i = text.indexOf(oldStr); i >= 0; i = text.indexOf(oldStr, i + oldStr.length)) count++;
  if (!count) {
    // common model slip: CRLF vs LF, or trailing whitespace differences -> give a targeted hint
    const hint = text.includes(oldStr.trim()) ? '（去掉首尾空白后能匹配，请检查缩进 / 空行）' : '（请先 read_file 或 grep 确认原文，old_string 必须逐字一致，包括缩进）';
    return { ok: false, message: `ERROR: 未找到 old_string ${hint}` };
  }
  if (count > 1 && !replaceAll) return { ok: false, message: `ERROR: old_string 出现 ${count} 次，不唯一。请包含更多上下文使其唯一，或设置 replace_all=true` };
  const content = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  return { ok: true, content, message: `OK: 替换 ${replaceAll ? count : 1} 处` };
}

export function editFile(abs, rel, { old_string, new_string, replace_all }) {
  if (!fs.existsSync(abs)) return { ok: false, message: `ERROR: 文件不存在 ${rel}（新建文件请用 write_file）` };
  const r = applyEdit(fs.readFileSync(abs, 'utf8'), old_string, new_string ?? '', !!replace_all);
  if (r.ok) fs.writeFileSync(abs, r.content);
  return { ok: r.ok, message: r.ok ? `${r.message}: ${rel}` : r.message };
}

const GREP_SKIP = new Set(['node_modules', '.git', '.superdemo', 'sdk']);
const BINARY_EXT = /\.(db|db-wal|db-shm|sqlite|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|mp[34]|wasm)$/i;

/** Regex search over text files. Returns "path:line: text" lines (capped). */
export function grepFiles(root, { pattern, path: rel = '.', glob, ignore_case }) {
  let re;
  try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch (e) { return `ERROR: 正则无效 ${e.message}`; }
  const globRe = glob ? new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') : null;
  const base = path.resolve(root, rel);
  if (base !== root && !base.startsWith(root + path.sep)) return 'ERROR: path escapes project';
  if (!fs.existsSync(base)) return `ERROR: 不存在 ${rel}`;
  const out = [], MAX = 200;
  let truncated = false;
  const visit = abs => {
    if (out.length >= MAX) { truncated = true; return; }
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs).sort()) if (!GREP_SKIP.has(n) && !n.startsWith('.DS_')) visit(path.join(abs, n));
      return;
    }
    const name = path.basename(abs);
    if (BINARY_EXT.test(name) || st.size > 2_000_000 || (globRe && !globRe.test(name))) return;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const r = path.relative(root, abs).split(path.sep).join('/');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (out.length >= MAX) { truncated = true; return; }
      out.push(`${r}:${i + 1}: ${lines[i].length > 240 ? lines[i].slice(0, 240) + '…' : lines[i]}`);
    }
  };
  visit(base);
  return out.length ? out.join('\n') + (truncated ? `\n...(仅显示前 ${MAX} 条，请缩小范围)` : '') : '(无匹配)';
}

/**
 * Syntax check for a JS file. Valid if it parses either as a classic script (browser files, sloppy mode) or via
 * `node --check` (ESM / CJS per package.json). Returns null when fine, else a short error text.
 */
export function checkSyntax(abs) {
  if (!/\.(m?js|cjs)$/.test(abs)) return Promise.resolve(null);
  const src = fs.readFileSync(abs, 'utf8');
  try { new vm.Script(src, { filename: abs }); return Promise.resolve(null); } catch {}
  return new Promise(resolve => {
    execFile(process.execPath, ['--check', abs], { timeout: 10_000 }, (err, _out, stderr) => {
      if (!err) return resolve(null);
      const lines = String(stderr).split('\n').filter(l => l && !/^\s+at /.test(l) && !l.startsWith('Node.js v'));
      resolve(lines.join('\n').replace(abs, path.basename(abs)).slice(0, 800) || 'SyntaxError');
    });
  });
}

/** HTTP request against a project's own port. Body: object -> JSON, string -> as is. */
export async function httpRequest(port, { method = 'GET', path: p = '/', body, headers = {} }, signal) {
  const url = `http://127.0.0.1:${port}/${String(p).replace(/^\/+/, '')}`;
  const init = { method: String(method).toUpperCase(), headers: { ...headers }, signal: anySignal(signal, AbortSignal.timeout(60_000)) };
  if (body !== undefined && body !== null && init.method !== 'GET' && init.method !== 'HEAD') {
    if (typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const ct = res.headers.get('content-type') || '';
    let text = await res.text();
    if (ct.includes('json')) { try { text = JSON.stringify(JSON.parse(text), null, 1); } catch {} }
    const max = 6000;
    return `HTTP ${res.status} ${res.statusText} · ${ct || '(no content-type)'} · ${Date.now() - t0}ms\n` +
      (text.length > max ? text.slice(0, max) + `\n...(已截断，共 ${text.length} 字符)` : text || '(空响应)');
  } catch (e) {
    if (signal?.aborted) return '[已被用户停止]';
    return `ERROR: 请求失败 ${e.cause?.code || e.name}: ${e.message}`;
  }
}

function anySignal(...signals) { return AbortSignal.any(signals.filter(Boolean)); }
