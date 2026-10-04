// PageBot: the agent's "eyes and hands" on the preview. The server has no browser, so when the agent calls page_view /
// page_act, an open SuperDemo tab claims the request and drives a preview iframe (the visible one when the user is
// looking at that project, otherwise an off-screen 1280×800 / 390×844 one).
// Demos run on their own origin (the demo port), so this tab can't touch their DOM: the looking and clicking is done by
// the in-page half (pagebot-core.js, injected by the proxy) and requested here through postMessage, with the project's
// preview key. If the demo origin isn't reachable from this browser, previews fall back to the shell's own origin.
const PageBot = (() => {
  const offscreen = new Map(); // projectId:device -> hidden iframe
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lastRefs = {};         // projectId:device -> refs of the last snapshot (re-find elements after a reload)

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({}));
  }

  // ---------- where demos live ----------
  let demoBase = null; // '' = same origin (fallback), else e.g. "http://192.168.1.5:18789"
  async function init() {
    if (demoBase !== null) return demoBase;
    const s = typeof settings !== 'undefined' ? settings : null;
    const cand = s?.demoUrl || (s?.demoPort ? `${location.protocol}//${location.hostname}:${s.demoPort}` : '');
    let ok = false;
    if (cand) { try { await fetch(cand + '/__sd/ping', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) }); ok = true; } catch {} }
    demoBase = ok ? cand : '';
    return demoBase;
  }
  const isolated = () => !!demoBase;
  const keyOf = id => (typeof projects !== 'undefined' && projects.find(p => p.id === id)?.previewKey) || '';
  function previewUrl(id, path = '') {
    const p = String(path || '').replace(/^\/+/, '').replace(/^p\/[^/]+\/?/, '');
    const [pathPart, hash = ''] = p.split('#');
    return `${demoBase || ''}/p/${id}/${pathPart}${pathPart.includes('?') ? '&' : '?'}_sdk=${keyOf(id)}&_sd=${Date.now()}${hash ? '#' + hash : ''}`;
  }
  /** Point a frame at a project page (the visible preview uses this too, so the bot knows what it shows). */
  function show(frame, id, path = '') {
    frame.dataset.project = id; frame.dataset.path = path ? '/' + String(path).replace(/^\/+/, '') : '/';
    frame.src = previewUrl(id, path);
  }
  function clear(frame) { delete frame.dataset.project; frame.src = 'about:blank'; }

  // ---------- messaging with the in-page bot ----------
  let seq = 0;
  const waiting = new Map();
  addEventListener('message', e => {
    const m = e.data;
    if (!m || m.sdBot !== 1 || !m.id) return;
    const w = waiting.get(m.id);
    if (!w || e.source !== w.frame.contentWindow) return;
    if (m.progress) { w.progress = m.progress; w.doneSteps = m.done; return; }
    waiting.delete(m.id); w.done(m);
  });
  function rpc(frame, op, payload = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = 'r' + (++seq);
      const t = setTimeout(() => { cleanup(); reject(new Error('页面没有响应（可能还在加载、不是网页，或已跳转）')); }, timeout);
      // the page navigated (a link or a form) while working: it can't answer any more -> what it reported so far
      const onLoad = () => { const w = waiting.get(id); cleanup(); resolve({ log: [...(w?.progress || []), '（页面跳转到了新地址）'], navigated: true, done: w?.doneSteps || 0 }); };
      const cleanup = () => { clearTimeout(t); waiting.delete(id); frame.removeEventListener('load', onLoad); };
      frame.addEventListener('load', onLoad);
      waiting.set(id, { frame, done: m => { cleanup(); m.ok ? resolve(m.result) : reject(new Error(m.error)); } });
      let origin = '*'; try { origin = new URL(frame.src).origin; } catch {}
      frame.contentWindow.postMessage({ sdBot: 1, k: keyOf(frame.dataset.project), id, op, ...payload }, origin);
    });
  }
  const waitLoad = (frame, ms = 15000) => new Promise(resolve => {
    const done = () => { clearTimeout(t); frame.removeEventListener('load', done); resolve(); };
    const t = setTimeout(done, ms); frame.addEventListener('load', done);
  });
  /** After a load: the in-page bot answers once the page (and its injected script) is up. */
  async function ready(frame) {
    for (let i = 0; i < 20; i++) { try { const r = await rpc(frame, 'ping', {}, 500); frame.dataset.path = r.path; return; } catch {} await sleep(150); }
    throw new Error('页面打不开或不是网页（预览里没有找到页面内容）');
  }
  async function navigate(frame, id, path = '') { const l = waitLoad(frame); show(frame, id, path); await l; await ready(frame); }
  const onProject = (frame, id) => frame.dataset.project === id && frame.src !== 'about:blank';

  // ---------- frames ----------
  const SIZES = { desktop: [1280, 800], mobile: [390, 844] };
  function hiddenFrame(projectId, device = 'desktop') {
    const key = projectId + ':' + device;
    let f = offscreen.get(key);
    if (!f || !f.isConnected) {
      const [w, hh] = SIZES[device];
      f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${hh}px;border:0;visibility:hidden`;
      document.body.appendChild(f);
      offscreen.set(key, f);
    }
    return f;
  }
  /** The visible preview is used when it matches the requested device (so the user can watch); otherwise an off-screen frame. */
  function pickFrame(projectId, device, visibleFrame) {
    const w = visibleFrame?.clientWidth || 0;
    if (visibleFrame && (device === 'mobile' ? w > 0 && w <= 500 : w >= 700)) return visibleFrame;
    return hiddenFrame(projectId, device);
  }

  /** Run actions; navigations (an explicit 'navigate' step, or a click that leaves the page) are followed here. */
  async function act(frame, id, actions, refKey) {
    const log = [];
    let todo = actions || [];
    for (let guard = 0; todo.length && guard < 10; guard++) {
      const r = await rpc(frame, 'act', { actions: todo, refs: lastRefs[refKey] }, 180000);
      log.push(...(r.log || []));
      if (r.refs) lastRefs[refKey] = r.refs;
      // the new page has loaded already (that's how we know); carry on with the steps after the one that navigated
      if (r.navigated) { await ready(frame); await rpc(frame, 'idle'); todo = todo.slice(r.done || todo.length); continue; }
      if (r.navigate == null) break;
      await navigate(frame, id, r.navigate);
      todo = r.rest || [];
    }
    return log;
  }
  async function snapshot(frame, refKey) {
    const r = await rpc(frame, 'snapshot');
    if (refKey && r.refs) lastRefs[refKey] = r.refs;
    frame.dataset.path = r.path;
    return r.text;
  }

  // ---------- entry ----------
  /** ev: { reqId, op: 'view' | 'act', args, vision, reload }. visibleFrame: the preview iframe if it shows this project. */
  async function handle(projectId, ev, visibleFrame) {
    const base = `/api/projects/${projectId}/browser/${ev.reqId}`;
    const claim = await post(base + '/claim', {});
    if (!claim.ok) return; // another tab took it
    try {
      await init();
      const device = ev.args?.device === 'mobile' ? 'mobile' : 'desktop';
      const frame = pickFrame(projectId, device, visibleFrame);
      const refKey = projectId + ':' + device;
      if (ev.reload || ev.args?.path != null || !onProject(frame, projectId)) await navigate(frame, projectId, ev.args?.path ?? (onProject(frame, projectId) ? frame.dataset.path : ''));
      else await ready(frame);
      await rpc(frame, 'idle');
      const log = ev.op === 'act' ? await act(frame, projectId, ev.args?.actions, refKey) : [];
      const text = (log.length ? `执行结果：\n${log.join('\n')}\n\n` : '') + await snapshot(frame, refKey);
      let image = null, imageInfo = '';
      if (ev.vision) {
        try { const s = await rpc(frame, 'screenshot', {}, 60000); image = s.dataUrl; imageInfo = `截图 ${s.width}×${s.height}（从页面顶部开始${s.scale < 1 ? `，缩放 ${s.scale.toFixed(2)}` : ''}）`; }
        catch (e) { imageInfo = '截图失败：' + e.message; }
      }
      await post(base + '/result', { ok: true, text: (device === 'mobile' ? '【手机 390×844】' : '') + text, image, imageInfo, visible: frame === visibleFrame });
    } catch (e) {
      await post(base + '/result', { ok: false, error: e.message || String(e) });
    }
  }

  /** Text snapshots of a few pages in a throwaway desktop frame (for the AI pre-test; doesn't touch the agent's frames). */
  async function withTempFrame(fn) {
    await init();
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    f.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:800px;border:0;visibility:hidden';
    document.body.appendChild(f);
    try { return await fn(f); } finally { f.remove(); }
  }
  async function capture(projectId, paths) {
    return withTempFrame(async f => {
      const out = [];
      for (const p of paths) {
        try { await navigate(f, projectId, p); await rpc(f, 'idle'); out.push({ path: '/' + p, text: await snapshot(f) }); } catch {}
      }
      return out;
    });
  }
  /** Run planned walkthroughs ([{path, goal, actions}]) and return what happened + the page after each. */
  // replan(goal, textSoFar) -> remaining actions; called (up to twice) when a step fails (the plan guessed at elements behind a click)
  async function walk(projectId, walks, replan) {
    return withTempFrame(async f => {
      const out = [];
      const run = async actions => { try { return await act(f, projectId, actions, 'pretest'); } catch (e) { return ['✗ ' + e.message]; } };
      for (const w of walks) {
        try { await navigate(f, projectId, w.path || ''); await rpc(f, 'idle'); } catch { continue; }
        await snapshot(f, 'pretest'); // fresh refs for this page
        let log = await run(w.actions);
        for (let k = 0; replan && k < 2 && log.some(l => l.startsWith('✗')); k++) {
          const rest = await replan(w.goal, `执行结果：\n${log.join('\n')}\n\n${await snapshot(f, 'pretest').catch(() => '')}`).catch(() => []);
          if (!rest.length) break;
          log = [...log.filter(l => !l.startsWith('✗')), ...await run(rest)];
        }
        out.push({ goal: w.goal || '', text: `执行结果：\n${log.join('\n')}\n\n${await snapshot(f, 'pretest').catch(() => '')}` });
      }
      return out;
    });
  }

  return { init, isolated, origin: () => demoBase, previewUrl, show, clear, handle, capture, walk };
})();
