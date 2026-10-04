// Owner notifications: a new visitor feedback is pushed to a team-chat bot (企业微信 / 飞书 / 钉钉 group robot, or any
// URL that accepts JSON), so a validation that runs for days doesn't need anyone watching SuperDemo.
// Contact details stay in SuperDemo: the message only says that someone left one.
import { getSettings } from './config.js';
import { REACTIONS } from './feedback.js';

/** Body in the format the bot expects, by host. */
export function botPayload(url, text) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (/qyapi\.weixin\.qq\.com$/.test(host)) return { msgtype: 'text', text: { content: text } };
  if (/(feishu\.cn|larksuite\.com)$/.test(host)) return { msg_type: 'text', content: { text } };
  if (/dingtalk\.com$/.test(host)) return { msgtype: 'text', text: { content: text } };
  return { text };
}

export function feedbackText(project, f, link) {
  const lines = [
    `【${project.name}】收到一条新反馈${f.share?.label ? `（来自「${f.share.label}」）` : ''}`,
    f.bug ? '🐞 报告：Demo 有地方坏了' : f.reaction ? `表态：${REACTIONS[f.reaction]}` : '',
    f.contact ? '📇 留了联系方式，想上线后第一时间用' : '',
    f.text ? `原话：${f.text.slice(0, 200)}` : '',
    ...(f.answers || []).slice(0, 3).map(a => `问：${a.q.slice(0, 40)}\n答：${a.a.slice(0, 120)}`),
    f.name ? `—— ${f.name}` : '',
    link ? `查看：${link}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function sendBot(url, text) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(botPayload(url, text)), signal: AbortSignal.timeout(8000) });
  const body = await r.text().catch(() => '');
  // the bots answer 200 with an error code in the body
  let j = {}; try { j = JSON.parse(body); } catch {}
  if (!r.ok || (j.errcode && j.errcode !== 0) || (j.code && j.code !== 0)) throw new Error(`推送失败：${r.status} ${(j.errmsg || j.msg || body).toString().slice(0, 120)}`);
}

/** Fire and forget: a failing bot must never break the visitor's submission. */
export function notifyFeedback(project, f) {
  const s = getSettings(), url = s.notifyWebhook;
  if (!url) return;
  const link = s.publicUrl ? `${s.publicUrl}/#/p/${project.id}` : '';
  sendBot(url, feedbackText(project, f, link)).catch(e => console.warn('[notify]', e.message));
}
