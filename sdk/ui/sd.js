// SuperDemo UI kit — include with <script src="_sd/sd.js"></script> (relative URL). Exposes a global `sd`.
// Zero dependencies. See sdk/README.md "前端组件库" for the API.
(function () {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = String(html).trim(); return t.content.firstElementChild; };
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /** fetch JSON with a relative path ("api/items"); body objects are sent as JSON; throws Error(message) on failure. */
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body !== undefined && typeof o.body !== 'string' && !(o.body instanceof FormData) && !(o.body instanceof Blob)) {
      o.body = JSON.stringify(o.body); o.headers['content-type'] = 'application/json';
    }
    if (o.body !== undefined && !o.method) o.method = 'POST';
    const res = await fetch(String(path).replace(/^\/+/, ''), o);
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error((data && data.error) || (typeof data === 'string' && data.length < 200 && data) || `请求失败（${res.status}）`);
    return data;
  }

  // ---------- formatting ----------
  const toDate = v => (v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/T(\d\d:\d\d(:\d\d)?)$/, 'T$1')));
  const pad = n => String(n).padStart(2, '0');
  const fmt = {
    num: (n, d = 0) => (n == null || n === '' || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })),
    money: (n, unit = '¥', d = 2) => (n == null || n === '' || isNaN(n) ? '—' : unit + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d })),
    pct: (n, d = 1) => (n == null || n === '' || isNaN(n) ? '—' : (Number(n) * 100).toFixed(d) + '%'), // n is a ratio: 0.123 -> 12.3%, 1.5 -> 150.0%
    date: v => { if (!v) return '—'; const d = toDate(v); return isNaN(d) ? String(v) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; },
    datetime: v => { if (!v) return '—'; const d = toDate(v); return isNaN(d) ? String(v) : `${fmt.date(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; },
    ago: v => {
      if (!v) return '—'; const d = toDate(v), s = (Date.now() - d) / 1000;
      if (isNaN(s)) return String(v); if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前'; return fmt.date(d);
    },
  };

  // ---------- toast ----------
  function toast(msg, type = 'ok', ms = 2600) {
    let box = $('.sd-toasts'); if (!box) { box = h('<div class="sd-toasts"></div>'); document.body.appendChild(box); }
    const el = h(`<div class="sd-toast ${esc(type)}"></div>`); el.textContent = msg; box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
  }

  // ---------- modal ----------
  /** modal({ title, content: html string | Node, actions: [{ text, primary, danger, onClick(close) -> false keeps open }], width }) */
  function modal({ title = '', content = '', actions = [{ text: '关闭' }], width, onClose } = {}) {
    const back = h(`<div class="sd-modal-backdrop"><div class="sd-modal" role="dialog" aria-modal="true">
      <div class="sd-modal-head"><h3></h3><button class="sd-btn-ghost sd-btn-sm" data-x aria-label="关闭">✕</button></div>
      <div class="sd-modal-body"></div><div class="sd-modal-foot"></div></div></div>`);
    const box = $('.sd-modal', back); if (width) box.style.width = `min(${width}px, 100%)`;
    $('h3', back).textContent = title;
    const body = $('.sd-modal-body', back); typeof content === 'string' ? (body.innerHTML = content) : body.appendChild(content);
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(v); };
    const onKey = e => { if (e.key === 'Escape' && back === $$('.sd-modal-backdrop').at(-1)) close(); }; // only the topmost modal
    document.addEventListener('keydown', onKey);
    $('[data-x]', back).onclick = () => close();
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    const foot = $('.sd-modal-foot', back);
    for (const a of actions) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a.text;
      b.className = a.primary ? 'sd-btn-primary' : a.danger ? 'sd-btn-danger sd-btn-solid' : '';
      b.onclick = async () => { if (!a.onClick) return close(); b.disabled = true; try { if ((await a.onClick(close)) !== false) close(); } finally { b.disabled = false; } };
      foot.appendChild(b);
    }
    if (!actions.length) foot.remove();
    document.body.appendChild(back);
    setTimeout(() => ($('input,select,textarea', body) || $('.sd-btn-primary', foot))?.focus(), 30);
    return { el: back, body, close };
  }

  /** confirm(message, { title, okText, danger }) -> Promise<boolean> */
  function confirm(message, { title = '请确认', okText = '确定', danger = false } = {}) {
    return new Promise(resolve => {
      let answered = false;
      const p = document.createElement('p'); p.textContent = message; p.style.margin = '0';
      modal({ title, content: p, onClose: () => { if (!answered) resolve(false); },
        actions: [{ text: '取消', onClick: () => { answered = true; resolve(false); } }, { text: okText, primary: !danger, danger, onClick: () => { answered = true; resolve(true); } }] });
    });
  }

  // ---------- forms ----------
  const attrs = f => ['min', 'max', 'step', 'pattern', 'title', 'maxlength', 'inputmode', 'autocomplete'].map(k => (f[k] != null ? ` ${k}="${esc(f[k])}"` : '')).join('');
  /** Field spec: { name, label, type: text|number|email|tel|date|datetime-local|select|textarea|checkbox, options: [v] | [{value,label}], required, placeholder, value, hint, full,
   *  min, max, step, pattern + title (its error message), maxlength, inputmode, autocomplete } */
  function fieldHtml(f) {
    const typedReq = /[*＊]\s*$/.test(String(f.label ?? ''));
    f = { ...f, label: String(f.label ?? '').replace(/\s*[*＊]+\s*$/, ''), required: f.required ?? (typedReq || undefined) }; // a typed "*" means required; the mark itself comes from the class
    const id = 'sdf-' + f.name + '-' + Math.random().toString(36).slice(2, 6);
    const req = f.required ? ' required' : '', ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    const v = f.value ?? '';
    let ctl;
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => (typeof o === 'object' ? o : { value: o, label: o }));
      // empty first option unless a value is preset: a required select then really has to be chosen
      const blank = opts.some(o => String(o.value) === '') || (f.required && v !== '') ? '' : `<option value="">${esc(f.placeholder || '请选择')}</option>`;
      ctl = `<select id="${id}" name="${esc(f.name)}"${req}>${blank}${opts.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') ctl = `<textarea id="${id}" name="${esc(f.name)}" rows="${f.rows || 3}"${req}${ph}${f.maxlength != null ? ` maxlength="${esc(f.maxlength)}"` : ''}>${esc(v)}</textarea>`;
    else if (f.type === 'checkbox') return `<div class="sd-field${f.full ? ' sd-field-full' : ''}"><label class="sd-check"><input type="checkbox" name="${esc(f.name)}"${v ? ' checked' : ''}> ${esc(f.label)}</label>${f.hint ? `<div class="sd-hint">${esc(f.hint)}</div>` : ''}</div>`;
    else ctl = `<input id="${id}" name="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(v)}"${req}${ph}${attrs(f)}>`;
    return `<div class="sd-field${f.full || f.type === 'textarea' ? ' sd-field-full' : ''}"><label for="${id}" class="${f.required ? 'sd-req' : ''}">${esc(f.label)}</label>${ctl}${f.hint ? `<div class="sd-hint">${esc(f.hint)}</div>` : ''}<div class="sd-error" hidden></div></div>`;
  }

  /** Read a form into an object: number inputs -> Number, checkboxes -> boolean, empty strings kept. */
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else if (el.type === 'number' || el.type === 'range') out[el.name] = el.value === '' ? null : Number(el.value);
      else out[el.name] = el.value.trim();
    }
    return out;
  }

  /** Native validity check with inline messages; returns true when valid. */
  function validate(form) {
    let ok = true;
    for (const f of $$('.sd-field', form)) {
      const el = $('input,select,textarea', f), err = $('.sd-error', f); if (!el || !err) continue;
      const bad = !el.checkValidity();
      f.classList.toggle('invalid', bad); err.hidden = !bad;
      const vd = el.validity;
      err.textContent = !bad ? '' : vd.valueMissing ? (el.tagName === 'SELECT' ? '请选择' : '必填') : vd.customError ? el.validationMessage
        : vd.typeMismatch ? (el.type === 'email' ? '邮箱格式不正确' : '格式不正确') : vd.patternMismatch ? (el.title || '格式不正确')
        : vd.rangeUnderflow ? `不能小于 ${el.min}` : vd.rangeOverflow ? `不能大于 ${el.max}` : vd.tooLong ? `最多 ${el.maxLength} 个字`
        : vd.stepMismatch ? '数值不符合要求' : vd.badInput ? '请输入有效的值' : el.validationMessage;
      if (bad && ok) { el.focus(); ok = false; }
    }
    return ok;
  }

  /** formModal({ title, fields, values, submitText, onSubmit(values) }) -> Promise<values | null>. onSubmit may throw to show an error and keep the dialog open. */
  function formModal({ title, fields, values = {}, submitText = '保存', onSubmit, width } = {}) {
    return new Promise(resolve => {
      let done = false;
      const form = h(`<form class="sd-form" novalidate>${fields.map(f => fieldHtml({ ...f, value: values[f.name] ?? f.value })).join('')}<div class="sd-error sd-field-full" data-err hidden></div></form>`);
      const submit = async () => {
        if (!validate(form)) return false;
        const v = formData(form);
        if (onSubmit) {
          try { await onSubmit(v); } catch (e) { const er = $('[data-err]', form); er.textContent = e.message; er.hidden = false; return false; }
        }
        done = true; resolve(v); return true;
      };
      form.addEventListener('submit', e => { e.preventDefault(); submit().then(ok => ok && m.close()); });
      const m = modal({ title, content: form, width, onClose: () => { if (!done) resolve(null); },
        actions: [{ text: '取消' }, { text: submitText, primary: true, onClick: () => submit() }] });
    });
  }

  // ---------- table ----------
  /**
   * table(el, { columns: [{ key, label, render(row) -> html, align: 'right', num: true, mobile: false (hide on phone cards), primary: true (card title on phones) }], rows, empty, actions: [{ text, danger, onClick(row), show(row) }], onRowClick(row) })
   * Renders a responsive table: on phones every row becomes a card (labels from column titles).
   */
  function table(el, { columns, rows, empty = '暂无数据', actions = [], onRowClick } = {}) {
    if (typeof el === 'string') el = $(el);
    if (!rows || !rows.length) { el.innerHTML = `<div class="sd-empty">${esc(empty)}</div>`; return; }
    const head = columns.map(c => `<th class="${c.num || c.align === 'right' ? 'sd-num' : ''}"${c.width ? ` style="width:${esc(c.width)}"` : ''}>${esc(c.label)}</th>`).join('') + (actions.length ? '<th class="sd-cell-actions">操作</th>' : '');
    const body = rows.map((r, i) => `<tr data-i="${i}"${onRowClick ? ' class="sd-clickable"' : ''}>${columns.map(c => {
      const v = c.render ? c.render(r) : esc(r[c.key] ?? '');
      return `<td data-label="${esc(c.label)}" class="${c.num || c.align === 'right' ? 'sd-num' : ''}${c.mobile === false ? ' sd-col-desktop' : ''}${c.primary ? ' sd-cell-primary' : ''}">${v === '' || v == null ? '<span class="sd-muted">—</span>' : v}</td>`;
    }).join('')}${actions.length ? `<td class="sd-cell-actions">${actions.map((a, j) => (a.show && !a.show(r) ? '' : `<button type="button" class="sd-btn-sm ${a.danger ? 'sd-btn-danger' : a.primary ? 'sd-btn-primary' : ''}" data-a="${j}">${esc(a.text)}</button>`)).join('')}</td>` : ''}</tr>`).join('');
    el.innerHTML = `<div class="sd-table-wrap"><table class="sd-table sd-cards"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    el.querySelector('tbody').onclick = e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const row = rows[+tr.dataset.i], btn = e.target.closest('[data-a]');
      if (btn) { e.stopPropagation(); actions[+btn.dataset.a].onClick(row, btn); return; }
      if (onRowClick && !e.target.closest('a,button,input,select,label')) onRowClick(row);
    };
  }

  /** pager(el, { page, pageSize, total, onChange(page) }) */
  function pager(el, { page = 1, pageSize = 20, total = 0, onChange }) {
    if (typeof el === 'string') el = $(el);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    el.className = 'sd-pager';
    el.innerHTML = `<span>共 ${total} 条</span><button type="button" data-p="${page - 1}"${page <= 1 ? ' disabled' : ''}>上一页</button><span>${page} / ${pages}</span><button type="button" data-p="${page + 1}"${page >= pages ? ' disabled' : ''}>下一页</button>`;
    el.onclick = e => { const b = e.target.closest('[data-p]'); if (b && !b.disabled) onChange(+b.dataset.p); };
  }

  /** tabs(container, onChange(value)): children with data-value; clicking sets .active. Returns { set(value) }. */
  function tabs(el, onChange) {
    if (typeof el === 'string') el = $(el);
    const set = v => { for (const c of el.children) c.classList.toggle('active', c.dataset.value === String(v)); };
    el.addEventListener('click', e => { const c = e.target.closest('[data-value]'); if (!c || !el.contains(c)) return; set(c.dataset.value); onChange?.(c.dataset.value); });
    return { set };
  }

  /** Status tag: tag('已完成', 'ok') -> html. Types: ok | warn | danger | info | brand | '' */
  const tag = (text, type = '') => `<span class="sd-tag ${esc(type)}">${esc(text)}</span>`;

  // ---------- charts (SVG, responsive via viewBox) ----------
  const BASE = ['#3b6cf6', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#64748b', '#f97316'];
  // first colour follows the theme (--sd-brand), so charts match a re-coloured page
  const PALETTE = new Proxy(BASE, { get(t, k) {
    if (k === '0') { const b = getComputedStyle(document.documentElement).getPropertyValue('--sd-brand').trim(); return b || t[0]; }
    return t[k];
  } });
  /** Axis scale with round ticks: pick the step first (1 / 2 / 2.5 / 5 × 10^n), then the max. */
  function niceScale(v) {
    if (!(v > 0)) return { max: 1, step: 0.25, n: 4 };
    const raw = v / 4, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
    const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
    const n = Math.max(1, Math.ceil(v / step - 1e-9));
    return { max: n * step, step, n };
  }
  const short = n => { const a = Math.abs(n); return a >= 1e8 ? (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿' : a >= 1e4 ? (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万' : String(Math.round(n * 100) / 100); };
  /** data: { labels: [...], values: [...] } or { labels, series: [{ name, values, color }] }; opts: { height, format(v) } */
  function series(data) { return data.series || [{ name: data.name || '', values: data.values || [], color: data.color }]; }
  function axisChart(el, data, kind, { height = 240, format = short } = {}) {
    if (typeof el === 'string') el = $(el);
    const labels = data.labels || [], ss = series(data);
    if (!labels.length) { el.innerHTML = '<div class="sd-empty">暂无数据</div>'; return; }
    const W = Math.max(320, el.clientWidth || 600), H = height, L = 46, R = 12, T = 12, B = 28;
    const scale = niceScale(Math.max(0, ...ss.flatMap(s => s.values.map(Number).filter(isFinite)))), max = scale.max;
    const iw = W - L - R, ih = H - T - B, x = i => L + (labels.length === 1 ? iw / 2 : kind === 'bar' ? (i + 0.5) * iw / labels.length : i * iw / (labels.length - 1)), y = v => T + ih - (v / max) * ih;
    let g = '';
    for (let k = 0; k <= scale.n; k++) { const v = scale.step * k, yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#eef0f4"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${esc(format(v))}</text>`; }
    // x labels: bars keep every label (shortened to fit the slot); lines thin them out
    const slot = iw / labels.length, fit = Math.max(2, Math.floor(slot / 11));
    const every = kind === 'bar' && slot >= 22 ? 1 : Math.ceil(labels.length / Math.max(1, Math.floor(iw / 56)));
    const cut = l => { const c = [...String(l)]; const n = kind === 'bar' ? Math.min(10, fit) : 10; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
    labels.forEach((l, i) => { if (i % every === 0) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle"><title>${esc(l)}</title>${esc(cut(l))}</text>`; });
    if (kind === 'bar') {
      const bw = Math.min(36, iw / labels.length * 0.7 / ss.length);
      ss.forEach((s, si) => s.values.forEach((v, i) => {
        const cx = x(i) - (bw * ss.length) / 2 + si * bw, yy = y(Math.max(0, +v || 0));
        g += `<rect x="${cx}" y="${yy}" width="${bw - 2}" height="${T + ih - yy}" rx="3" fill="${s.color || PALETTE[si % PALETTE.length]}"><title>${esc(labels[i])}${s.name ? ' · ' + esc(s.name) : ''}：${esc(format(+v || 0))}</title></rect>`;
      }));
    } else {
      ss.forEach((s, si) => {
        const c = s.color || PALETTE[si % PALETTE.length], pts = s.values.map((v, i) => `${x(i)},${y(+v || 0)}`).join(' ');
        if (ss.length === 1) g += `<polygon points="${L},${T + ih} ${pts} ${x(s.values.length - 1)},${T + ih}" fill="${c}" opacity=".08"/>`;
        g += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
        s.values.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(+v || 0)}" r="3" fill="#fff" stroke="${c}" stroke-width="2"><title>${esc(labels[i])}${s.name ? ' · ' + esc(s.name) : ''}：${esc(format(+v || 0))}</title></circle>`; });
      });
    }
    el.classList.add('sd-chart');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>` + (ss.length > 1 ? legend(ss.map((s, i) => [s.name, s.color || PALETTE[i % PALETTE.length]])) : '');
  }
  const legend = items => `<div class="sd-legend">${items.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;
  /** pie/donut: { labels, values }; opts: { height, format, donut: true } */
  function pie(el, data, { height = 220, format = short, donut = true } = {}) {
    if (typeof el === 'string') el = $(el);
    const vals = (data.values || []).map(v => Math.max(0, +v || 0)), total = vals.reduce((a, b) => a + b, 0);
    if (!total) { el.innerHTML = '<div class="sd-empty">暂无数据</div>'; return; }
    const r = height / 2 - 4, cx = height / 2, cy = height / 2;
    let a0 = -Math.PI / 2, g = '';
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0, c = PALETTE[i % PALETTE.length];
      const p = vals.length === 1 ? `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx - 0.01},${cy - r}Z` : `M${cx},${cy}L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}Z`;
      g += `<path d="${p}" fill="${c}" stroke="#fff" stroke-width="2"><title>${esc(data.labels[i])}：${esc(format(v))}（${(v / total * 100).toFixed(1)}%）</title></path>`;
      a0 = a1;
    });
    if (donut) g += `<circle cx="${cx}" cy="${cy}" r="${r * 0.58}" fill="#fff"/><text x="${cx}" y="${cy - 2}" text-anchor="middle" style="font-size:12px">合计</text><text x="${cx}" y="${cy + 16}" text-anchor="middle" style="font-size:15px;font-weight:700;fill:#1f2430">${esc(format(total))}</text>`;
    el.classList.add('sd-chart');
    el.innerHTML = `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 ${height} ${height}" style="width:${height}px;max-width:100%">${g}</svg>${legend(data.labels.map((l, i) => [`${l} ${(vals[i] / total * 100).toFixed(0)}%`, PALETTE[i % PALETTE.length]])).replace('sd-legend"', 'sd-legend" style="flex-direction:column;flex:1;min-width:120px"')}</div>`;
  }
  /** Horizontal bars (rankings): full labels on the left, value on the right; reads well on phones. */
  function hbar(el, data, { format = short, max: maxRows = 12 } = {}) {
    if (typeof el === 'string') el = $(el);
    const rows = (data.labels || []).map((l, i) => [l, Math.max(0, +(data.values || [])[i] || 0)]).slice(0, maxRows);
    if (!rows.length) { el.innerHTML = '<div class="sd-empty">暂无数据</div>'; return; }
    const top = Math.max(...rows.map(r => r[1])) || 1, c = data.color || PALETTE[0];
    el.classList.add('sd-chart');
    el.innerHTML = `<div class="sd-hbar">${rows.map(([l, v]) => `<div class="sd-hbar-row" title="${esc(l)}：${esc(format(v))}"><span class="sd-hbar-label">${esc(l)}</span><span class="sd-hbar-track"><i style="width:${(v / top * 100).toFixed(1)}%;background:${c}"></i></span><span class="sd-hbar-value">${esc(format(v))}</span></div>`).join('')}</div>`;
  }
  // Note: multi-series line/bar charts share ONE y axis — don't mix scales (e.g. revenue and order count) in one chart.
  const chart = { bar: (el, d, o = {}) => (o.horizontal ? hbar(el, d, o) : axisChart(el, d, 'bar', o)), line: (el, d, o) => axisChart(el, d, 'line', o), pie, palette: PALETTE };

  /** Button busy state while an async action runs: await sd.busy(btn, () => sd.api(...)) */
  async function busy(btn, fn) {
    const html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="sd-spinner"></span> ${btn.textContent}`;
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
  }

  window.sd = { $, $$, esc, h, api, fmt, toast, modal, confirm, formModal, fieldHtml, formData, validate, table, pager, tabs, tag, chart, busy, debounce };
})();
