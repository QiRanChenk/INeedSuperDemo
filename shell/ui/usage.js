// Token usage dialog: range presets, bucketing, SVG line chart with crosshair tooltip, per-project table.
(function () {
  const $ = s => document.querySelector(s);
  const COLORS = { total: '#3987e5', input: '#d95926', output: '#199e70' };
  const LABEL = { total: '合计', input: '输入', output: '输出' };
  const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const DAY = 86400000;

  let entries = [], names = {}, range = { from: 0, to: 0, key: 'today' }, series = new Set(['total']);

  function presetRange(key) {
    const now = new Date(), t0 = startOfDay(now);
    switch (key) {
      case 'today': return [t0.getTime(), now.getTime()];
      case 'yesterday': return [t0.getTime() - DAY, t0.getTime() - 1];
      case '7d': return [t0.getTime() - 6 * DAY, now.getTime()];
      case 'week': { const d = (t0.getDay() + 6) % 7; return [t0.getTime() - d * DAY, now.getTime()]; }
      case '30d': return [t0.getTime() - 29 * DAY, now.getTime()];
      case 'month': return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime()];
      case 'year': return [new Date(now.getFullYear(), 0, 1).getTime(), now.getTime()];
      case 'lastyear': return [new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime() - 1];
      case 'all': return [0, now.getTime()];
    }
  }

  async function load() {
    const res = await fetch(`/api/usage/log?from=${range.from}&to=${range.to}`);
    const data = await res.json();
    entries = data.entries; names = data.names || {};
    if (range.key === 'all' && entries.length) range.from = startOfDay(new Date(Math.min(...entries.map(e => e.t)))).getTime();
    $('#usFrom').value = dateStr(new Date(range.from || Date.now())); $('#usTo').value = dateStr(new Date(range.to));
    for (const b of document.querySelectorAll('#usQuick button')) b.classList.toggle('on', b.dataset.r === range.key);
    render();
  }

  function bucketOf(span) { return span <= 2 * DAY ? 'hour' : span <= 400 * DAY ? 'day' : 'month'; }
  function bucketStart(t, kind) {
    const d = new Date(t);
    if (kind === 'hour') d.setMinutes(0, 0, 0); else if (kind === 'day') d.setHours(0, 0, 0, 0); else { d.setDate(1); d.setHours(0, 0, 0, 0); }
    return d.getTime();
  }
  function nextBucket(t, kind) { const d = new Date(t); if (kind === 'hour') d.setHours(d.getHours() + 1); else if (kind === 'day') d.setDate(d.getDate() + 1); else d.setMonth(d.getMonth() + 1); return d.getTime(); }
  const bucketLabel = (t, kind) => { const d = new Date(t); return kind === 'hour' ? `${pad(d.getHours())}:00` : kind === 'day' ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}`; };
  const bucketFull = (t, kind) => { const d = new Date(t); return kind === 'hour' ? `${dateStr(d)} ${pad(d.getHours())}:00` : kind === 'day' ? dateStr(d) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  function render() {
    const tot = entries.reduce((a, e) => { a.input += e.i; a.output += e.o; a.cached += e.c; a.calls++; return a; }, { input: 0, output: 0, cached: 0, calls: 0 });
    const hit = tot.input ? Math.round(tot.cached / tot.input * 100) : 0;
    $('#usTotals').innerHTML = `<span>输入<b>${fmt(tot.input)}</b></span><span>输出<b>${fmt(tot.output)}</b></span><span>缓存命中<b>${hit}%</b></span><span>合计<b>${fmt(tot.input + tot.output)}</b></span><span>调用<b>${tot.calls} 次</b></span>`;

    // per-project table (always present: the accessible/table view of the same data)
    const byP = {};
    for (const e of entries) { const k = e.p || '(未知)'; byP[k] ||= { input: 0, output: 0, cached: 0, calls: 0 }; byP[k].input += e.i; byP[k].output += e.o; byP[k].cached += e.c; byP[k].calls++; }
    const rows = Object.entries(byP).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
    $('#usTable').innerHTML = rows.length ? `<thead><tr><th>项目</th><th>调用</th><th>输入</th><th>输出</th><th>缓存命中</th><th>合计</th></tr></thead><tbody>` +
      rows.map(([k, v]) => `<tr><td>${esc(names[k] || k)}</td><td>${v.calls}</td><td>${fmt(v.input)}</td><td>${fmt(v.output)}</td><td>${v.input ? Math.round(v.cached / v.input * 100) : 0}%</td><td>${fmt(v.input + v.output)}</td></tr>`).join('') + '</tbody>' : '';

    drawChart();
  }

  function drawChart() {
    const host = $('#usChart'); host.querySelectorAll('svg, .empty').forEach(n => n.remove());
    const tip = $('#usTip'); tip.hidden = true;
    if (!entries.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = '该时间段没有 Token 消耗记录'; host.appendChild(d); $('#usBucket').textContent = ''; return; }

    const span = range.to - range.from, kind = bucketOf(span);
    $('#usBucket').textContent = `按${kind === 'hour' ? '小时' : kind === 'day' ? '天' : '月'}统计`;
    const map = new Map();
    for (let t = bucketStart(range.from, kind); t <= range.to; t = nextBucket(t, kind)) map.set(t, { t, total: 0, input: 0, output: 0, calls: 0 });
    for (const e of entries) { const b = map.get(bucketStart(e.t, kind)); if (b) { b.input += e.i; b.output += e.o; b.total += e.i + e.o; b.calls++; } }
    const pts = [...map.values()];
    const active = ['total', 'input', 'output'].filter(k => series.has(k));
    const W = host.clientWidth || 900, H = host.clientHeight || 280, m = { l: 56, r: 64, t: 16, b: 28 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const ymax = Math.max(1, ...pts.flatMap(p => active.map(k => p[k])));
    const nice = niceMax(ymax);
    const x = i => m.l + (pts.length > 1 ? i / (pts.length - 1) * iw : iw / 2);
    const y = v => m.t + ih - v / nice * ih;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Token 消耗折线图');
    let g = '<g class="grid">';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) { const v = nice / ticks * i; g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" fill="#8b93a7" font-size="11">${fmt(v)}</text>`; }
    g += '</g><g class="axis">';
    const step = Math.max(1, Math.ceil(pts.length / Math.floor(iw / 70)));
    pts.forEach((p, i) => { if (i % step === 0 || i === pts.length - 1) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${bucketLabel(p.t, kind)}</text>`; });
    g += '</g>';
    for (const k of active) {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
      g += `<path class="series" d="${d}" stroke="${COLORS[k]}"/>`;
      if (pts.length <= 60) pts.forEach((p, i) => { g += `<circle class="pt" cx="${x(i)}" cy="${y(p[k])}" r="4" fill="${COLORS[k]}"/>`; });
      const last = pts[pts.length - 1];
      g += `<text class="endlabel" x="${W - m.r + 6}" y="${y(last[k]) + 4}">${LABEL[k]}</text>`;
    }
    g += `<line id="usCross" class="cross" y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0" visibility="hidden"/>`;
    svg.innerHTML = g;
    host.appendChild(svg);

    // crosshair + tooltip: nearest bucket on x
    host.onmousemove = ev => {
      const r = host.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
      let best = 0, bd = Infinity; pts.forEach((p, i) => { const d = Math.abs(x(i) - px); if (d < bd) { bd = d; best = i; } });
      const p = pts[best]; const cx = x(best);
      const cross = svg.querySelector('#usCross'); cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<div><b>${bucketFull(p.t, kind)}</b> · ${p.calls} 次调用</div>` + active.map(k => `<div><span class="k" style="color:${COLORS[k]}">●</span>${LABEL[k]} ${fmt(p[k])}</div>`).join('');
      tip.hidden = false;
      const left = cx / W * r.width; tip.style.left = Math.min(left + 12, r.width - tip.offsetWidth - 8) + 'px'; tip.style.top = '12px';
    };
    host.onmouseleave = () => { tip.hidden = true; svg.querySelector('#usCross')?.setAttribute('visibility', 'hidden'); };
  }

  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10; return m * p; }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- wiring ----
  $('#usQuick').onclick = e => { const b = e.target.closest('button[data-r]'); if (!b) return; const [f, t] = presetRange(b.dataset.r); range = { from: f, to: t, key: b.dataset.r }; load(); };
  const custom = () => {
    const f = $('#usFrom').value, t = $('#usTo').value; if (!f || !t) return;
    const from = new Date(f + 'T00:00:00').getTime(), to = new Date(t + 'T23:59:59.999').getTime();
    if (to < from) return;
    range = { from, to: Math.min(to, Date.now() + DAY), key: 'custom' }; load();
  };
  $('#usFrom').onchange = custom; $('#usTo').onchange = custom;
  $('#usLegend').onchange = e => { const k = e.target.dataset.s; if (!k) return; e.target.checked ? series.add(k) : series.delete(k); if (!series.size) { series.add('total'); $('#usLegend input[data-s=total]').checked = true; } drawChart(); };
  $('#usClose').onclick = () => $('#dlgUsage').close();
  window.addEventListener('resize', () => { if ($('#dlgUsage').open) drawChart(); });

  window.UsageDialog = {
    open(key = 'today') { const [f, t] = presetRange(key); range = { from: f, to: t, key }; $('#dlgUsage').showModal(); load(); },
    async refreshSummary() {
      try { const s = await (await fetch('/api/usage/summary')).json(); $('#tsToday').textContent = fmt(s.today.total); $('#tsAll').textContent = fmt(s.all.total); } catch {}
    },
  };
})();
