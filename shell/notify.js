// Owner notifications: a new visitor feedback is pushed to a team-chat bot (企业微信 / 飞书 / 钉钉 group robot, or any
// URL that accepts JSON), so a validation that runs for days doesn't need anyone watching SuperDemo.
// Contact details stay in SuperDemo: the message only says that someone left one.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, DATA_DIR } from './config.js';
import { REACTIONS, listFeedback } from './feedback.js';
import { listProjects } from './registry.js';
import { listShares, shareStats } from './shares.js';

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

// ---- evening digest: one message a day with what happened on every shared idea today ----

const STATE = path.join(DATA_DIR, 'notify-state.json');
const DIGEST_HOUR = 21;
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export function digestText(now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const lines = [];
  for (const p of listProjects()) {
    const shares = listShares(p.id).filter(s => s.active);
    if (!shares.length) continue;
    let visitors = 0, actors = 0;
    for (const s of shares) { const st = shareStats(s.token, 1, start.getTime()); visitors += st.visitors; actors += st.actors; }
    const fb = listFeedback(p.id).filter(f => f.ts >= start.getTime());
    if (!visitors && !fb.length) continue;
    const r = { up: 0, meh: 0, down: 0 }; for (const f of fb) if (f.reaction) r[f.reaction]++;
    const contacts = fb.filter(f => f.contact).length, bugs = fb.filter(f => f.bug).length;
    lines.push(`· ${p.name}：访客 ${visitors}、真动手 ${actors}${fb.length ? `、反馈 ${fb.length}（👍${r.up} 🤔${r.meh} 👎${r.down}）` : ''}${contacts ? `、留联系方式 ${contacts}` : ''}${bugs ? `、🐞报错 ${bugs}` : ''}`);
  }
  return lines.length ? `【SuperDemo 今日验证小结】\n${lines.join('\n')}` : '';
}

/** Called every few minutes: after 21:00, once a day, if a bot is set and something happened today. */
export async function runDigest(now = Date.now()) {
  const s = getSettings();
  if (!s.notifyWebhook || new Date(now).getHours() < DIGEST_HOUR) return;
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  if (st.digest === dayKey(now)) return;
  const text = digestText(now);
  if (text) await sendBot(s.notifyWebhook, text + (s.publicUrl ? `\n查看：${s.publicUrl}` : ''));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ ...st, digest: dayKey(now) }));
}
