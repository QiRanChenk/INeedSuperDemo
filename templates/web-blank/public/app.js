// All URLs are relative ("api/...") because the app is served under a sub-path.
async function load() {
  const list = await sd.api('api/notes');
  sd.$('#notes').innerHTML = list.length
    ? list.map(n => `<li><span class="sd-spacer">${sd.esc(n.text)}</span><span class="sd-muted sd-small">${sd.fmt.ago(n.created_at + 'Z')}</span></li>`).join('')
    : '<li class="sd-empty">还没有记录，在上面写下第一条</li>';
}
sd.$('#noteForm').onsubmit = async e => {
  e.preventDefault();
  try { await sd.api('api/notes', { body: sd.formData(e.target) }); e.target.reset(); sd.toast('已添加'); load(); }
  catch (err) { sd.toast(err.message, 'error'); }
};
(async () => {
  const info = await sd.api('api/info');
  document.title = info.project;
  sd.$('#brand').textContent = sd.$('#title').textContent = info.project;
  sd.$('.sd-brand-logo').textContent = [...info.project][0] || 'D';
  load();
})();
