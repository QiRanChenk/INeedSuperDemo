// 报名页：渲染表单 -> 提交 -> 显示报名编号；下方按编号 + 手机号查询进度。
const form = sd.$('#form'), lookup = sd.$('#lookup');

async function init() {
  const info = await sd.api('api/info').catch(() => null);
  if (info) {
    document.title = info.event.title;
    sd.$$('[data-project]').forEach(el => (el.textContent = info.project));
    sd.$('#evTitle').textContent = info.event.title;
    sd.$('#evIntro').textContent = info.event.intro;
    sd.$('#evTime').textContent = info.event.time;
    sd.$('#evPlace').textContent = info.event.place;
    Object.assign(FIELDS.find(f => f.name === 'session'), { options: info.sessions, placeholder: '请选择场次' });
  }
  form.insertAdjacentHTML('afterbegin', FIELDS.map(sd.fieldHtml).join(''));
  liveValidate(form);

  lookup.innerHTML = [
    { name: 'code', label: '报名编号', required: true, placeholder: '如 BM20261003-0042' },
    { name: 'phone', label: '手机号', type: 'tel', required: true, placeholder: '报名时填写的手机号' },
  ].map(sd.fieldHtml).join('') + '<div class="sd-form-actions"><button type="submit" class="sd-btn-block">查询</button></div>';
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!validateForm(form)) return;
  try {
    const r = await sd.busy(sd.$('#submitBtn'), () => sd.api('api/submissions', { body: sd.formData(form) }));
    lookup.elements.code.value = r.code;
    lookup.elements.phone.value = form.elements.phone.value;
    sd.$('#doneCode').textContent = r.code;
    sd.$('#formCard').hidden = true;
    sd.$('#doneCard').hidden = false;
    sd.$('#lookupResult').innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    sd.toast(err.message, 'error', 4000);
  }
});

sd.$('#copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(sd.$('#doneCode').textContent); sd.toast('报名编号已复制'); }
  catch { sd.toast('请长按编号手动复制', 'error'); }
};
sd.$('#againBtn').onclick = () => {
  form.reset();
  sd.$('#doneCard').hidden = true;
  sd.$('#formCard').hidden = false;
  form.elements.name.focus();
};
sd.$('#checkBtn').onclick = () => { sd.$('#lookupCard').scrollIntoView({ behavior: 'smooth' }); lookup.requestSubmit(); };

lookup.addEventListener('submit', async e => {
  e.preventDefault();
  if (!sd.validate(lookup)) return;
  const { code, phone } = sd.formData(lookup), out = sd.$('#lookupResult');
  try {
    const r = await sd.busy(lookup.querySelector('button[type=submit]'), () => sd.api(`api/submissions/lookup?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`));
    const tip = { 待审核: '工作人员正在审核，请耐心等待。', 已通过: '恭喜，报名已通过！请在活动当天凭手机号签到。', 已驳回: '很抱歉，本次报名未通过。' }[r.status] || '';
    out.innerHTML = `<div class="result">
      <div class="result-head">${statusTag(r.status)}<b>${sd.esc(r.name)}</b><span class="sd-muted sd-small">${sd.esc(r.code)}</span></div>
      <div class="sd-small">${sd.esc(r.session)}</div>
      <p class="sd-small">${sd.esc(tip)}</p>
      ${r.review_note ? `<div class="note"><span class="sd-muted">审核意见：</span>${sd.esc(r.review_note)}</div>` : ''}
      <div class="sd-small sd-muted">提交于 ${sd.fmt.datetime(r.created_at)}${r.reviewed_at ? ` · 审核于 ${sd.fmt.datetime(r.reviewed_at)}` : ''}</div>
    </div>`;
  } catch (err) {
    out.innerHTML = `<div class="sd-empty">${sd.esc(err.message)}</div>`;
  }
});

init();
