// End to end: a throwaway shell (temp dirs, free ports) + a real headless Chrome driven over the DevTools protocol
// (Node's built-in WebSocket, no extra dependencies). Checks what the agent's page tools rely on since demos moved to
// their own origin: the preview is cross-origin, and PageBot still reads pages, clicks, follows navigations and flags
// buttons that do nothing. Skipped when no Chrome is installed (set CHROME_PATH to point at one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find(p => p && fs.existsSync(p));
const skip = !CHROME && 'no Chrome found (set CHROME_PATH)';

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tmp, shell, chrome, cdp, PORT, DEMO_PORT, projectId;

async function waitHttp(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok || r.status === 204) return; } catch {} await sleep(200); }
  throw new Error('not up: ' + url);
}

/** Minimal CDP client: send(method, params, sessionId) -> result. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); } };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }),
      close: () => ws.close(),
    });
  });
}

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-e2e-'));
  [PORT, DEMO_PORT] = [await freePort(), await freePort()];
  shell = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'shell/server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), SUPERDEMO_DEMO_PORT: String(DEMO_PORT), HOST: '127.0.0.1', SUPERDEMO_PASSWORD: '',
      SUPERDEMO_PROJECTS_DIR: path.join(tmp, 'projects'), SUPERDEMO_DATA_DIR: path.join(tmp, 'data'), LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' },
  });
  await waitHttp(`http://127.0.0.1:${PORT}/api/health`);
  // a project with three pages: a working button, a link to page 2, and a button wired to nothing
  const r = await fetch(`http://127.0.0.1:${PORT}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'e2e', description: 'e2e', type: 'web' }) });
  projectId = (await r.json()).id;
  const pub = path.join(tmp, 'projects', projectId, 'public');
  fs.writeFileSync(path.join(pub, 'index.html'), `<!doctype html><html><head><title>首页</title></head><body><h1>测试首页</h1>
    <p id="t">原来的字</p><button onclick="document.getElementById('t').textContent='改过的字'">改文字</button>
    <a href="page2.html">去第二页</a></body></html>`);
  fs.writeFileSync(path.join(pub, 'page2.html'), `<!doctype html><html><head><title>第二页</title></head><body><h1>第二页</h1><button>坏按钮</button></body></html>`);
  // Chrome: headless, own profile, DevTools port written to a file
  const profile = path.join(tmp, 'chrome');
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) { try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); } }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  cdp = await connect(ver.webSocketDebuggerUrl);
});

after(async () => {
  try { cdp?.close(); } catch {}
  chrome?.kill('SIGKILL'); shell?.kill('SIGTERM');
  await sleep(500);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('agent page tools work across the demo origin', { skip, timeout: 90000 }, async () => {
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/#/p/${projectId}` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression, ms = 60000) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: ms }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100; i++) { if (await evaluate('typeof PageBot !== "undefined" && typeof projects !== "undefined" && projects.length > 0').catch(() => false)) break; await sleep(200); }

  const out = await evaluate(`(async () => {
    await PageBot.init();
    const id = ${JSON.stringify(projectId)};
    const caps = await PageBot.capture(id, ['', 'page2.html']);
    const walks = await PageBot.walk(id, [{ path: '', goal: 'flow', actions: [
      { type: 'click', text: '改文字' }, { type: 'click', text: '去第二页' }, { type: 'click', text: '坏按钮' } ] }]);
    const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f);
    await new Promise(r => { f.onload = r; PageBot.show(f, id); });
    let cross; try { void f.contentWindow.document.body; cross = 'readable'; } catch (e) { cross = 'blocked'; }
    return { isolated: PageBot.isolated(), origin: PageBot.origin(), caps: caps.map(c => c.path + ' ' + c.text.split('\\n')[0]), walk: walks[0]?.text || '', cross };
  })()`);

  assert.equal(out.isolated, true, 'preview runs on the demo origin');
  assert.equal(out.origin, `http://127.0.0.1:${DEMO_PORT}`);
  assert.equal(out.cross, 'blocked', "the shell can't (and the demo can't) reach across");
  assert.match(out.caps[0], /^\/ 页面 \/ · 标题「首页」/);
  assert.match(out.caps[1], /^\/page2\.html 页面 \/page2\.html · 标题「第二页」/);
  const log = out.walk.split('\n\n')[0];
  assert.match(log, /1\. click 「改文字」 「改文字」\n/, 'a working button is not flagged');
  assert.ok(!/改文字」[^\n]*没有任何变化/.test(log));
  assert.match(log, /页面跳转到了新地址/, 'link navigation is followed');
  assert.match(log, /坏按钮」（点击后页面没有任何变化）/, 'the remaining step runs on the new page and a dead button is flagged');
  assert.match(out.walk, /# 第二页/);
});

test('demo origin refuses previews without the key, and the shell refuses cross-origin writes', { skip }, async () => {
  assert.equal((await fetch(`http://127.0.0.1:${DEMO_PORT}/p/${projectId}/`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${DEMO_PORT}/api/projects`)).status, 404);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/projects/${projectId}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site', origin: `http://127.0.0.1:${DEMO_PORT}` }, body: '{}' });
  assert.equal(r.status, 403);
});
