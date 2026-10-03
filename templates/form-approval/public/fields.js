// 表单字段：前端唯一定义处。报名页（form.js）用它渲染表单，审核台（admin.js）用它渲染详情。
// 改成其它表单（请假申请、采购申请……）时：改这里 + server.js 的 FIELDS（校验与入库），两边 name 保持一致。
// 字段写法同 sd.fieldHtml：{ name, label, type, required, placeholder, hint, options, min, max, full }；
// check(value) 可选，返回错误提示文字（空字符串表示通过），用于格式校验。
const FIELDS = [
  { name: 'name', label: '姓名', required: true, placeholder: '请填写真实姓名' },
  { name: 'phone', label: '手机号', type: 'tel', required: true, placeholder: '11 位手机号', hint: '用于接收审核通知和查询进度',
    check: v => (/^1\d{10}$/.test(v) ? '' : '请填写 11 位手机号') },
  { name: 'company', label: '单位名称', required: true, placeholder: '公司或机构全称' },
  { name: 'title', label: '职务', placeholder: '如：运营经理' },
  { name: 'email', label: '邮箱', type: 'email', placeholder: '用于接收会议资料', check: v => (!v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : '邮箱格式不正确') },
  { name: 'attendees', label: '参会人数', type: 'number', required: true, min: 1, max: 5, value: 1, hint: '含本人，最多 5 人',
    check: v => (/^[1-5]$/.test(v) ? '' : '请填写 1–5 之间的人数') },
  { name: 'session', label: '参加场次', type: 'select', required: true, full: true, options: [] },   // 选项由服务端 api/info 下发
  { name: 'needs', label: '备注 / 需求', type: 'textarea', placeholder: '如需发票、停车位、饮食禁忌等，请在此说明' },
];

// 审核状态 -> 标签颜色
const STATUS_TONE = { 待审核: 'warn', 已通过: 'ok', 已驳回: 'danger' };
const statusTag = s => sd.tag(s, STATUS_TONE[s] || '');

/** Run each field's check() (as custom validity) then sd.validate; returns true when the whole form is valid. */
function validateForm(form) {
  for (const f of FIELDS) {
    const el = form.elements[f.name];
    if (el && f.check) el.setCustomValidity(el.value.trim() ? f.check(el.value.trim()) : '');
  }
  return sd.validate(form);
}

/** Clear a field's inline error as soon as the user fixes it. */
function liveValidate(form) {
  form.addEventListener('input', e => {
    const box = e.target.closest('.sd-field'), f = FIELDS.find(x => x.name === e.target.name);
    if (!box || !box.classList.contains('invalid')) return;
    if (f?.check) e.target.setCustomValidity(e.target.value.trim() ? f.check(e.target.value.trim()) : '');
    if (e.target.checkValidity()) { box.classList.remove('invalid'); box.querySelector('.sd-error').hidden = true; }
  });
}
