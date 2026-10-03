// PageBot: the agent's "eyes and hands" on the preview. The server has no browser, so when the agent calls page_view /
// page_act, an open SuperDemo tab claims the request, works on the same-origin preview iframe (the visible one when the
// user is looking at that project, otherwise an off-screen 1280×800 one), and posts back a text snapshot (+ screenshot).
const PageBot = (() => {
  const offscreen = new Map(); // projectId -> hidden iframe
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({}));
  }

  function hiddenFrame(projectId) {
    let f = offscreen.get(projectId);
    if (!f || !f.isConnected) {
      f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:800px;border:0;visibility:hidden';
      document.body.appendChild(f);
      offscreen.set(projectId, f);
    }
    return f;
  }

  const onProject = (frame, projectId) => { try { return frame.contentWindow.location.pathname.startsWith(`/p/${projectId}/`); } catch { return false; } };

  function navigate(frame, projectId, path = '') {
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); frame.removeEventListener('load', done); resolve(); };
      const t = setTimeout(done, 15000);
      frame.addEventListener('load', done);
      const p = String(path || '').replace(/^\/+/, '').replace(/^p\/[^/]+\/?/, '');
      const [pathPart, hash = ''] = p.split('#');
      frame.src = `/p/${projectId}/${pathPart}${pathPart.includes('?') ? '&' : '?'}_sd=${Date.now()}${hash ? '#' + hash : ''}`;
    });
  }

  /** Wait until the page is loaded and has no in-flight fetch/XHR for a moment (counter kept by the proxy-injected script). */
  async function waitIdle(frame, max = 8000) {
    const t0 = Date.now(); let quietSince = 0;
    while (Date.now() - t0 < max) {
      let busy = true;
      try { const w = frame.contentWindow; busy = w.document.readyState !== 'complete' || (w.__sdInflight || 0) > 0; } catch {}
      if (!busy) { if (!quietSince) quietSince = Date.now(); if (Date.now() - quietSince >= 350) return; }
      else quietSince = 0;
      await sleep(80);
    }
  }

  // ---------- snapshot (text) ----------
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[onclick],[contenteditable=""],[contenteditable=true]';
  const clip = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

  function nameOf(el) {
    const lab = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName); // their innerText is option text / empty, not a name
    return clip(el.getAttribute('aria-label') || (lab && lab.innerText) || el.closest('label')?.innerText || (!field && el.innerText) || (el.tagName === 'INPUT' && el.value) || el.placeholder || el.getAttribute('name') || el.title || el.getAttribute('alt') || '', 50);
  }

  function parseColor(c) { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r, g, b, a }; }
  function lum({ r, g, b }) { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
  function bgOf(win, el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = win.getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // can't judge over images / gradients
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const describeEl = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');

  function snapshot(frame) {
    const win = frame.contentWindow, doc = win.document;
    const vw = win.innerWidth, vh = win.innerHeight, se = doc.scrollingElement || doc.documentElement;
    doc.querySelectorAll('[data-sd-ref]').forEach(e => e.removeAttribute('data-sd-ref'));
    const refs = {}; // ref -> { name, tag }: lets page_act re-find an element after the page re-rendered it
    const out = [], issues = [];
    let ref = 0, chars = 0, truncated = false;
    const emit = (depth, s) => { if (chars > 9000) { truncated = true; return; } const line = '  '.repeat(Math.min(depth, 6)) + s; out.push(line); chars += line.length; };
    const styleOf = el => win.getComputedStyle(el);
    const shown = el => { const cs = styleOf(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0 || cs.display === 'contents'; };
    const lowContrast = [], clipped = [];

    function inter(el, depth) {
      const id = 'e' + (++ref); el.setAttribute('data-sd-ref', id);
      const r = el.getBoundingClientRect(), tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
      const flags = [];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('禁用');
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) flags.push('视口外');
      else if (r.width >= 1 && r.height >= 1) {
        const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
        const top = doc.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) flags.push(`被遮挡(${describeEl(top)})`);
      }
      const name = nameOf(el);
      let s;
      if (tag === 'select') s = `下拉「${name}」 当前="${clip(el.options[el.selectedIndex]?.text, 30)}" 选项: ${[...el.options].slice(0, 12).map(o => clip(o.text, 20)).join(' | ')}${el.options.length > 12 ? ` …共${el.options.length}项` : ''}`;
      else if (tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(type))) {
        s = `输入框(${type || tag})「${clip(el.closest('label')?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name, 40)}」 值="${clip(el.value, 60)}"${el.placeholder ? ` 占位="${clip(el.placeholder, 30)}"` : ''}${el.required ? ' 必填' : ''}`;
      } else if (type === 'checkbox' || type === 'radio' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') s = `${type === 'radio' ? '单选' : '勾选框'}「${name}」 ${el.checked || el.getAttribute('aria-checked') === 'true' ? '已选' : '未选'}`;
      else if (type === 'file') s = `文件选择「${name}」（无法自动上传文件）`;
      else if (tag === 'a') s = `链接「${name || '(无文字)'}」 → ${clip(el.getAttribute('href'), 60)}`;
      else {
        // custom toggles (chips / tabs / segmented buttons) usually signal state with ARIA or a class
        const on = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')
          || (typeof el.className === 'string' && /(^|[\s_-])(on|active|selected|checked|current)($|[\s_-])/.test(el.className));
        s = `${tag === 'button' || el.getAttribute('role') ? '按钮' : '可点击'}「${name || '(无文字)'}」${on ? ' 已选中' : ''}`;
      }
      if (!name && tag !== 'input' && tag !== 'select' && tag !== 'textarea') issues.push(`[${id}] 可点击元素没有文字或标签`);
      emit(depth, `[${id}] ${s}${flags.length ? ' (' + flags.join(', ') + ')' : ''}`);
      refs[id] = { name, tag };
    }

    function table(el, depth) {
      const rows = [...el.rows].filter(shown);
      const head = rows[0] ? [...rows[0].cells].map(c => clip(c.innerText, 16)).join(' | ') : '';
      emit(depth, `表格 ${rows.length} 行 × ${rows[0]?.cells.length || 0} 列：${head}`);
      for (const r of rows.slice(1, 4)) emit(depth + 1, [...r.cells].map(c => clip(c.innerText, 16)).join(' | '));
      if (rows.length > 4) emit(depth + 1, `…另有 ${rows.length - 4} 行`);
      let n = 0; // still expose controls inside the table (row actions), capped
      for (const c of el.querySelectorAll(INTERACTIVE)) { if (n++ >= 20) { emit(depth + 1, '…更多表格内操作已省略'); break; } if (shown(c)) inter(c, depth + 1); }
    }

    function walk(el, depth) {
      if (truncated) return;
      for (const child of el.children) {
        const tag = child.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template', 'link', 'meta'].includes(tag) || !shown(child)) continue;
        // JS click handlers can't be seen from the DOM; cursor:pointer (set on the element itself, not inherited) is the best hint
        if (child.matches(INTERACTIVE) || (styleOf(child).cursor === 'pointer' && styleOf(child.parentElement).cursor !== 'pointer' && child.innerText.trim().length <= 40)) { inter(child, depth); continue; }
        if (tag === 'table') { table(child, depth); continue; }
        if (/^h[1-4]$/.test(tag)) { emit(depth, `${'#'.repeat(+tag[1])} ${clip(child.innerText, 100)}`); continue; }
        if (tag === 'img') {
          if (child.complete && !child.naturalWidth) issues.push(`图片加载失败: ${clip(child.getAttribute('src'), 80)}`);
          emit(depth, `图片「${clip(child.alt, 30) || '无说明'}」 ${Math.round(child.getBoundingClientRect().width)}×${Math.round(child.getBoundingClientRect().height)}`); continue;
        }
        if (tag === 'canvas' || tag === 'svg') { const r = child.getBoundingClientRect(); if (r.width > 40 && r.height > 40) emit(depth, `${tag === 'canvas' ? '画布/图表' : '图形'} ${Math.round(r.width)}×${Math.round(r.height)}`); continue; }
        const own = [...child.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (own) {
          emit(depth, clip(child.innerText.includes(own) && child.children.length === 0 ? child.innerText : own, 160));
          const cs = styleOf(child), fg = parseColor(cs.color), bg = fg && bgOf(win, child);
          if (fg && bg && lowContrast.length < 6) { const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); if (ratio < 3) lowContrast.push(`「${clip(own, 20)}」对比度 ${ratio.toFixed(1)}`); }
          if (clipped.length < 6 && child.scrollWidth > child.clientWidth + 1 && ['hidden', 'clip'].includes(cs.overflowX)) clipped.push(`「${clip(child.innerText, 24)}」(${describeEl(child)})`);
        }
        walk(child, depth + (own ? 1 : 0));
      }
    }
    walk(doc.body, 0);

    if (se.scrollWidth > vw + 2) {
      const wide = [...doc.body.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.right > vw + 2 && r.width > 0; }).slice(0, 5).map(describeEl);
      issues.unshift(`页面出现横向滚动：内容宽 ${se.scrollWidth}px > 视口 ${vw}px，超出元素: ${wide.join(', ')}`);
    }
    if (lowContrast.length) issues.push('文字对比度过低: ' + lowContrast.join('；'));
    if (clipped.length) issues.push('文字被截断: ' + clipped.join('；'));
    const blocked = out.filter(l => l.includes('被遮挡')).length;
    if (blocked) issues.push(`${blocked} 个可操作元素被其他元素遮挡（见上文标记）`);

    win.__sdRefs = refs;
    const head = `页面 ${win.location.pathname.replace(/^\/p\/[^/]+/, '') || '/'}${win.location.hash} · 标题「${clip(doc.title, 40)}」 · 视口 ${vw}×${vh} · 页面高 ${se.scrollHeight}px · 已滚动到 ${Math.round(se.scrollTop)}`;
    return `${head}\n${out.join('\n')}${truncated ? '\n…(内容过长已截断)' : ''}\n\n自动检查：${issues.length ? '\n- ' + issues.join('\n- ') : '未发现明显布局问题'}`;
  }

  // ---------- screenshot (SVG foreignObject -> canvas -> JPEG) ----------
  async function toDataUrl(url) {
    try {
      const blob = await (await fetch(url)).blob();
      return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
    } catch { return null; }
  }

  async function screenshot(frame, { maxHeight = 2400, maxWidth = 1280 } = {}) {
    const win = frame.contentWindow, doc = win.document;
    const vw = win.innerWidth, se = doc.scrollingElement || doc.documentElement;
    const height = Math.min(Math.max(win.innerHeight, se.scrollHeight), maxHeight);
    const clone = doc.documentElement.cloneNode(true);
    // form state lives in properties, not attributes
    const src = doc.querySelectorAll('input,textarea,select,canvas'), dst = clone.querySelectorAll('input,textarea,select,canvas');
    src.forEach((el, i) => {
      const c = dst[i]; if (!c) return;
      if (el.tagName === 'INPUT') { if (el.type === 'checkbox' || el.type === 'radio') el.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked'); else c.setAttribute('value', el.value); }
      else if (el.tagName === 'TEXTAREA') c.textContent = el.value;
      else if (el.tagName === 'SELECT') [...c.options].forEach((o, j) => o.toggleAttribute('selected', j === el.selectedIndex));
      else if (el.tagName === 'CANVAS') { try { const img = doc.createElement('img'); img.src = el.toDataURL(); img.width = el.width; img.style.cssText = el.style.cssText; img.className = el.className; img.style.width = el.getBoundingClientRect().width + 'px'; img.style.height = el.getBoundingClientRect().height + 'px'; c.replaceWith(img); } catch {} }
    });
    clone.querySelectorAll('script,noscript,iframe,link[rel="stylesheet"],style').forEach(e => e.remove());
    // stylesheets are same-origin (served through the proxy) -> inline their rules
    let css = '';
    for (const sheet of doc.styleSheets) { try { css += [...sheet.cssRules].map(r => r.cssText).join('\n') + '\n'; } catch {} }
    const style = doc.createElement('style'); style.textContent = css;
    (clone.querySelector('head') || clone).appendChild(style);
    // images -> data URLs (an SVG image cannot load external resources)
    await Promise.all([...clone.querySelectorAll('img')].slice(0, 60).map(async img => {
      const s = img.getAttribute('src'); if (!s || s.startsWith('data:')) return;
      const d = await toDataUrl(new URL(s, win.location.href).href); if (d) img.setAttribute('src', d); else img.removeAttribute('src');
    }));
    clone.style.setProperty('width', vw + 'px');
    const body = clone.querySelector('body'); if (body) body.style.setProperty('margin-top', (parseFloat(win.getComputedStyle(doc.body).marginTop) || 0) + 'px');
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('截图渲染失败')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const scale = Math.min(1, maxWidth / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale); canvas.height = Math.round(height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = win.getComputedStyle(doc.body).backgroundColor && parseColor(win.getComputedStyle(doc.body).backgroundColor)?.a > 0 ? win.getComputedStyle(doc.body).backgroundColor : '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.78), width: vw, height, scale };
  }

  // ---------- actions ----------
  // alert / confirm / prompt would block the agent: answer them automatically during actions, then put the originals back
  function hookDialogs(win, log) {
    try {
      if (win.__sdDialogs) return;
      win.__sdDialogs = { alert: win.alert, confirm: win.confirm, prompt: win.prompt };
      win.alert = m => { log.push(`弹窗提示: ${clip(m, 120)}`); };
      win.confirm = m => { log.push(`确认框「${clip(m, 120)}」→ 已点确定`); return true; };
      win.prompt = (m, d) => { log.push(`输入框弹窗「${clip(m, 80)}」→ 返回默认值`); return d ?? ''; };
    } catch {}
  }
  function unhookDialogs(win) {
    try { const o = win.__sdDialogs; if (!o) return; win.alert = o.alert; win.confirm = o.confirm; win.prompt = o.prompt; delete win.__sdDialogs; } catch {}
  }

  /** Set a form value so frameworks (React etc.) notice: native setter of the element's own realm + input/change events. */
  function setValue(el, value) {
    const W = el.ownerDocument.defaultView;
    const C = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement : el.tagName === 'SELECT' ? W.HTMLSelectElement : W.HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(C.prototype, 'value')?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new W.Event('input', { bubbles: true }));
    el.dispatchEvent(new W.Event('change', { bubbles: true }));
  }

  async function act(frame, projectId, actions) {
    const log = [];
    for (const [i, a] of (actions || []).slice(0, 20).entries()) {
      const win = frame.contentWindow, doc = win.document;
      hookDialogs(win, log);
      const n = `${i + 1}. ${a.type}`;
      const find = () => {
        let el = a.ref ? doc.querySelector(`[data-sd-ref="${a.ref}"]`) : a.selector ? doc.querySelector(a.selector) : null;
        // re-rendered since the snapshot (e.g. a list redrawn after a click): look it up again by tag + name
        const meta = !el && a.ref && (win.__sdRefs || window.__sdLastRefs?.[projectId])?.[a.ref];
        if (meta?.name) {
          const hits = [...doc.querySelectorAll(meta.tag)].filter(e => nameOf(e) === meta.name);
          if (hits.length === 1) { el = hits[0]; el.setAttribute('data-sd-ref', a.ref); }
        }
        if (!el) throw new Error(`${n}: 找不到元素 ${a.ref || a.selector || '(未指定 ref)'}（页面已变化，请先 page_view 获取新的 ref）`);
        return el;
      };
      try {
        if (a.type === 'click') { const el = find(); el.scrollIntoView({ block: 'center' }); el.focus?.(); el.click(); log.push(`${n} [${a.ref || a.selector}] 「${nameOf(el)}」`); }
        else if (a.type === 'fill') { const el = find(); el.focus?.(); setValue(el, String(a.value ?? '')); log.push(`${n} [${a.ref || a.selector}] = "${clip(a.value, 40)}"`); }
        else if (a.type === 'select') {
          const el = find(); const opt = [...el.options].find(o => o.value === String(a.value) || o.text.trim() === String(a.value).trim());
          if (!opt) throw new Error(`${n}: 下拉中没有选项 "${a.value}"`);
          setValue(el, opt.value); log.push(`${n} [${a.ref || a.selector}] 选择 "${opt.text.trim()}"`);
        } else if (a.type === 'check') { const el = find(); if (el.checked !== (a.value !== false)) el.click(); log.push(`${n} [${a.ref || a.selector}] ${a.value !== false ? '勾选' : '取消勾选'}`); }
        else if (a.type === 'press') {
          const el = doc.activeElement || doc.body, key = a.value || 'Enter';
          for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new win.KeyboardEvent(t, { key, bubbles: true, cancelable: true }));
          if (key === 'Enter' && el.form && el.tagName === 'INPUT') el.form.requestSubmit?.();
          log.push(`${n} 按键 ${key}`);
        } else if (a.type === 'scroll') { win.scrollTo(0, a.ref ? find().getBoundingClientRect().top + win.scrollY - 80 : Number(a.value) || 0); log.push(`${n} 滚动`); }
        else if (a.type === 'navigate') { await navigate(frame, projectId, a.value || ''); log.push(`${n} 打开 ${a.value || '/'}`); }
        else if (a.type === 'wait') { await sleep(Math.min(Number(a.value) || 1000, 8000)); log.push(`${n} 等待 ${a.value || 1000}ms`); }
        else throw new Error(`${n}: 未知操作类型`);
      } catch (e) { log.push('✗ ' + e.message); unhookDialogs(win); break; }
      await sleep(120);
      await waitIdle(frame, 6000);
      try { unhookDialogs(win); } catch {}
    }
    return log;
  }

  // ---------- entry ----------
  /** ev: { reqId, op: 'view' | 'act', args, vision, reload }. visibleFrame: the preview iframe if it shows this project. */
  async function handle(projectId, ev, visibleFrame) {
    const base = `/api/projects/${projectId}/browser/${ev.reqId}`;
    const claim = await post(base + '/claim', {});
    if (!claim.ok) return; // another tab took it
    try {
      const frame = visibleFrame || hiddenFrame(projectId);
      if (ev.reload || ev.args?.path != null || !onProject(frame, projectId)) await navigate(frame, projectId, ev.args?.path || (onProject(frame, projectId) ? frame.contentWindow.location.pathname.replace(/^\/p\/[^/]+\/?/, '') + frame.contentWindow.location.hash : ''));
      await waitIdle(frame);
      let log = [];
      if (ev.op === 'act') { if (!frame.contentWindow.__sdRefs && window.__sdLastRefs?.[projectId]) frame.contentWindow.__sdRefs = window.__sdLastRefs[projectId]; log = await act(frame, projectId, ev.args?.actions); }
      const text = (log.length ? `执行结果：\n${log.join('\n')}\n\n` : '') + snapshot(frame);
      (window.__sdLastRefs ||= {})[projectId] = frame.contentWindow.__sdRefs;
      let image = null, imageInfo = '';
      if (ev.vision) {
        try { const s = await screenshot(frame); image = s.dataUrl; imageInfo = `截图 ${s.width}×${s.height}（从页面顶部开始${s.scale < 1 ? `，缩放 ${s.scale.toFixed(2)}` : ''}）`; }
        catch (e) { imageInfo = '截图失败：' + e.message; }
      }
      await post(base + '/result', { ok: true, text, image, imageInfo, visible: !!visibleFrame });
    } catch (e) {
      await post(base + '/result', { ok: false, error: e.message || String(e) });
    }
  }

  return { handle, snapshot, screenshot, act }; // snapshot / screenshot / act exposed for debugging from the console
})();
