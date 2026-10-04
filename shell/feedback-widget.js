// Visitor feedback widget injected into share-link pages. Written as a real function and shipped as its source
// (`(${widget})(config)`), so it stays readable. Shadow DOM isolates it from the demo's CSS and vice versa.
// Design notes from a phone audit: an edge tab (right-middle) instead of a bottom button, because demos keep their own
// actions, tab bars and number pads at the bottom; a bottom sheet with backdrop and ×; one question shown, the rest
// optional; a "something's broken" switch so bug reports don't pollute the verdict; a real thank-you, no auto-close.
function widget(cfg) {
  if (window.__sdFb) return; window.__sdFb = 1;
  var QS = cfg.questions, key = 'sdFbDone:' + cfg.token;
  var host = document.createElement('div');
  // no transform / position on the host: it would become the containing block of the fixed panel inside
  host.style.cssText = 'position:static';
  var r = host.attachShadow({ mode: 'open' });
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var done = false; try { done = !!localStorage.getItem(key); } catch (e) {}
  r.innerHTML = '<style>'
    + '*{box-sizing:border-box;font:15px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}'
    + '.tab{position:fixed;right:0;top:58%;transform:translateY(-50%);z-index:2147483000;writing-mode:vertical-rl;letter-spacing:2px;border:0;border-radius:10px 0 0 10px;padding:12px 7px;background:#3b6cf6;color:#fff;cursor:pointer;box-shadow:-2px 4px 14px rgba(0,0,0,.22);font-size:14px}'
    + '.tab.done{background:#16a34a}'
    + '.bd{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.38);display:none}.bd.o{display:block}'
    + '.p{position:fixed;z-index:2147483002;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 32px);background:#fff;color:#1f2430;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column}'
    + '.p.o{display:flex}.hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 6px}.hd b{font-size:17px}'
    + '.x{border:0;background:none;font-size:24px;line-height:1;color:#9ca3af;cursor:pointer;padding:0 4px}'
    + '.bdy{overflow:auto;padding:0 16px 8px}.ft{padding:10px 16px 14px;border-top:1px solid #f0f1f4}'
    + 'label{display:block;font-size:14px;color:#4b5563;margin:12px 0 4px}textarea,input{width:100%;border:1px solid #e5e7eb;border-radius:10px;padding:9px 11px;resize:vertical;font-size:16px}'
    + '.rx{display:flex;gap:8px}.rx button{flex:1;border:1px solid #e5e7eb;background:#fff;border-radius:12px;padding:12px 4px;cursor:pointer;font-size:15px}'
    + '.rx button.on{border-color:#3b6cf6;background:#eef3ff;color:#1d4ed8;font-weight:600}'
    + '.bug{margin-top:8px;border:1px dashed #e5e7eb;background:#fff;border-radius:10px;padding:6px 10px;color:#6b7280;cursor:pointer;font-size:13px}.bug.on{border-color:#f59e0b;background:#fffbeb;color:#b45309}'
    + '.more{border:0;background:none;color:#3b6cf6;padding:8px 0 0;cursor:pointer;font-size:14px}.hint{font-size:12px;color:#9ca3af;margin-top:3px}'
    + '.s{width:100%;border:0;border-radius:12px;padding:12px;background:#3b6cf6;color:#fff;font-size:16px;font-weight:600;cursor:pointer}.s:disabled{opacity:.6}'
    + '.m{font-size:13px;min-height:18px;margin-top:6px;color:#dc2626}.ty{text-align:center;padding:28px 16px 18px}.ty .big{font-size:40px}.ty p{color:#4b5563;margin:8px 0 18px}'
    + '.ty button{border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:9px 22px;cursor:pointer}'
    + '@media (max-width:600px){.p{left:0;right:0;bottom:0;width:auto;max-height:88vh;border-radius:16px 16px 0 0}}'
    + '</style><button class="tab" aria-label="说说看法"></button><div class="bd"></div><div class="p" role="dialog" aria-label="说说看法"></div>';
  var tab = r.querySelector('.tab'), bd = r.querySelector('.bd'), p = r.querySelector('.p');
  function setTab() { tab.textContent = done ? '✓ 已反馈' : '💬 说说看法'; tab.classList.toggle('done', done); }
  function close() { p.classList.remove('o'); bd.classList.remove('o'); }
  function form() {
    var first = QS[0], rest = QS.slice(1);
    p.innerHTML = '<div class="hd"><b>这个对你有用吗？</b><button class="x" aria-label="关闭">×</button></div><div class="bdy">'
      + '<div class="rx"><button data-v="up">👍 有用</button><button data-v="meh">🤔 一般</button><button data-v="down">👎 用不上</button></div>'
      + '<button class="bug" type="button">🐞 有地方坏了 / 点了没反应</button>'
      + '<div class="ct" hidden><label>真上线了想第一时间用上？留个微信或手机号（可选）</label><input class="cv" maxlength="60" autocomplete="tel"><div class="hint">上线时通知你，不会推销；只有做这个的人能看到</div></div>'
      + (first ? '<label>' + esc(first) + '</label><input data-q="0" placeholder="可选，说一句就行">' : '')
      + (rest.length ? '<div class="rq" hidden>' + rest.map(function (q, i) { return '<label>' + esc(q) + '</label><input data-q="' + (i + 1) + '" placeholder="可选">'; }).join('') + '</div><button class="more" type="button">再回答 ' + rest.length + ' 个问题（可选）</button>' : '')
      + '<label class="tl">还有什么想说的（可选）</label><textarea rows="2" placeholder="例如：字太小；我想按把卖"></textarea>'
      + '<label>怎么称呼（可选）</label><input class="n" maxlength="40">'
      + '</div><div class="ft"><button class="s">提交</button><div class="m"></div></div>';
    var rx = '', bug = false, t = p.querySelector('textarea'), m = p.querySelector('.m'), s = p.querySelector('.s');
    p.querySelector('.x').onclick = close;
    p.querySelectorAll('.rx button').forEach(function (b) {
      b.onclick = function () {
        rx = rx === b.dataset.v ? '' : b.dataset.v;
        p.querySelectorAll('.rx button').forEach(function (x) { x.classList.toggle('on', x.dataset.v === rx); });
        p.querySelector('.ct').hidden = rx !== 'up';
      };
    });
    p.querySelector('.bug').onclick = function () {
      bug = !bug; this.classList.toggle('on', bug);
      p.querySelector('.tl').textContent = bug ? '哪里坏了？（点了什么、出现了什么）' : '还有什么想说的（可选）';
      t.placeholder = bug ? '例如：点「保存」后数字没变' : '例如：字太小；我想按把卖';
      if (bug) t.focus();
    };
    var more = p.querySelector('.more');
    if (more) more.onclick = function () { p.querySelector('.rq').hidden = false; more.remove(); };
    s.onclick = function () {
      var ans = [].map.call(p.querySelectorAll('[data-q]'), function (i) { return { q: QS[+i.dataset.q], a: i.value.trim() }; }).filter(function (x) { return x.a; });
      var v = t.value.trim(), name = p.querySelector('.n').value.trim();
      if (!v && !rx && !ans.length) { m.textContent = bug ? '说一句哪里坏了' : '点一个看法，或者写一句话'; return; }
      s.disabled = true; m.style.color = '#6b7280'; m.textContent = '提交中…';
      fetch('/s/' + cfg.token + '/__sd/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        reaction: rx, answers: ans, text: v, name: name, bug: bug, contact: rx === 'up' ? p.querySelector('.cv').value.trim() : '',
        page: location.pathname.replace(/^\/s\/[^/]+/, '') + location.hash, viewport: innerWidth + 'x' + innerHeight }) })
        .then(function (x) { return x.json().then(function (j) { if (!x.ok) throw new Error(j.error || '提交失败，请再试一次'); }); })
        .then(function () {
          done = true; try { localStorage.setItem(key, '1'); } catch (e) {} setTab();
          p.innerHTML = '<div class="ty"><div class="big">🙏</div><b>谢谢' + (name ? esc(name) : '') + '！</b><p>你的看法已经收到了。' + (bug ? '坏掉的地方会尽快修。' : '') + '<br>想到别的，随时再点右边的按钮。</p><button>关闭</button></div>';
          p.querySelector('.ty button').onclick = close;
        })
        .catch(function (e) { m.style.color = '#dc2626'; m.textContent = e.message; s.disabled = false; });
    };
  }
  tab.onclick = function () { form(); p.classList.add('o'); bd.classList.add('o'); };
  bd.onclick = close;
  setTab();
  (document.body || document.documentElement).appendChild(host);
}

/** Script source for one share link. */
export function feedbackScript(token, questions) {
  const cfg = JSON.stringify({ token, questions: questions.slice(0, 4).map(q => String(q).slice(0, 120)) }).replace(/</g, '\\u003c');
  return `(${widget.toString()})(${cfg});`;
}
