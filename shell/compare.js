// Idea portfolio: the same evidence the verdict report uses, side by side for every idea, so "which one is worth
// pursuing" can be answered at a glance (rule-based signal + next step), and optionally by the LLM.
import fs from 'node:fs';
import path from 'node:path';
import { listProjects } from './registry.js';
import { evidence, getReport, currentRound, VERDICTS } from './report.js';
import { getPretest } from './personas.js';
import { DATA_DIR } from './config.js';
import { chat } from './llm.js';
import { logUsage } from './usagelog.js';
import { normalizeUsage } from './agent.js';

const MIN_SAMPLE = 5;
const ADVICE = path.join(DATA_DIR, 'compare-advice.json');

/** Rule of thumb from the numbers: how strong the evidence is and what to do next. */
export function judge(m) {
  if (!m.visitors && !m.reacted) return { signal: 'none', label: '还没人试', next: m.pretest ? '已做过模拟试用：生成分享链接，发给 5 位以上目标用户' : '先「AI 模拟试用」挑一遍毛病，再发给目标用户' };
  const n = Math.max(m.visitors, m.reacted);
  if (n < MIN_SAMPLE) return { signal: 'thin', label: '样本不足', next: `再找 ${MIN_SAMPLE - n} 位以上目标用户试用，结论才可信` };
  if (m.score >= 0.5) return { signal: 'strong', label: '信号强', next: m.contacts ? `联系留了联系方式的 ${m.contacts} 人深聊，验证愿不愿意付费/长期用` : '找动手的人深聊，确认会不会长期用' };
  if (m.score >= 0.25) return { signal: 'mixed', label: '有苗头', next: '按结论改一版，开新一轮验证看指标能否上升' };
  return { signal: 'weak', label: '信号弱', next: '换一批目标人群再试一轮；仍然弱就考虑放下' };
}

export function ideaMetrics(p) {
  const ev = evidence(p.id), r = ev.reactions, reacted = r.up + r.meh + r.down, report = getReport(p.id), pt = getPretest(p.id);
  const visitors = ev.visitors, n = Math.max(visitors, reacted); // older feedback may come without tracked visits
  const actRate = n ? Math.min(1, ev.actors / n) : 0, upRate = reacted ? r.up / reacted : 0, contactRate = n ? Math.min(1, ev.contacts / n) : 0;
  // actions and contacts weigh more than words (same principle as the verdict report)
  const score = +(0.4 * actRate + 0.25 * upRate + 0.35 * contactRate).toFixed(2);
  const m = {
    id: p.id, name: p.name, hypothesis: p.plan?.hypothesis || p.description || '', criteria: p.plan?.criteria || '', round: currentRound(p.id).n,
    visitors, actors: ev.actors, contacts: ev.contacts, reacted, up: r.up, meh: r.meh, down: r.down, medianMs: ev.medianMs, actRate, upRate, contactRate, score,
    verdict: report?.verdict || null, verdictLabel: report ? VERDICTS[report.verdict] : null, verdictSummary: report?.summary || '',
    pretest: pt ? pt.personas.reduce((a, x) => (a[x.reaction]++, a), { up: 0, meh: 0, down: 0 }) : null,
  };
  return { ...m, ...judge(m) };
}

const ORDER = { strong: 0, mixed: 1, thin: 2, weak: 3, none: 4 };
export function compareIdeas() {
  return listProjects().filter(p => p.plan || p.built).map(ideaMetrics)
    .sort((a, b) => ORDER[a.signal] - ORDER[b.signal] || b.score - a.score || b.visitors - a.visitors);
}

export function getAdvice() { try { return JSON.parse(fs.readFileSync(ADVICE, 'utf8')); } catch { return null; } }

export async function adviseIdeas() {
  const list = compareIdeas().filter(m => m.visitors || m.reacted || m.pretest);
  if (list.length < 2) throw new Error('至少要有 2 个想法有试用数据（真人或 AI 模拟）才好比较');
  const lines = list.map(m => `- [${m.id}] ${m.name}：假设「${m.hypothesis}」${m.criteria ? `；成立标准「${m.criteria}」` : ''}；第 ${m.round} 轮；有效样本 ${Math.max(m.visitors, m.reacted)} 人（${Math.max(m.visitors, m.reacted) >= MIN_SAMPLE ? '够下初步结论' : '不足 5 人'}）；规则判断「${m.label}」；访客 ${m.visitors}、动手 ${m.actors}、留联系方式 ${m.contacts}、👍${m.up} 🤔${m.meh} 👎${m.down}${m.medianMs ? `、停留中位数 ${Math.round(m.medianMs / 1000)} 秒` : ''}${m.verdict ? `；结论「${m.verdictLabel}」${m.verdictSummary}` : ''}${m.pretest ? `；AI 模拟用户（非真人，仅供参考）👍${m.pretest.up} 🤔${m.pretest.meh} 👎${m.pretest.down}` : ''}`);
  const r = await chat({ thinking: false, temperature: 0.3, messages: [
    { role: 'system', content: `你是严谨的产品投资顾问。用户同时在验证多个想法，请根据真实试用证据给出取舍建议。行为（动手、留联系方式）比表态可信；样本少于 5 人的不能下定论，要说明；AI 模拟数据只能参考，不能当证据。只依据给出的数据，不编造。还没有真人数据的想法（只有 AI 模拟或没人试）不要建议放下，只说「还没验证」。summary 和 todo 里用想法名称，不要写方括号里的 id。
只输出 JSON：{"summary":"一句话总体建议，不超过 60 字","focus":"最值得继续投入的想法 id，没有足够证据就留空","ranking":[{"id":"想法 id","why":"排序理由，不超过 40 字，引用数字"}],"park":["建议暂时放下的想法 id"],"todo":["接下来一周最该做的 2-3 件事，具体到哪个想法"]}` },
    { role: 'user', content: lines.join('\n') },
  ] });
  const u = normalizeUsage(r.usage);
  if (u) logUsage({ p: '_compare', i: u.input, o: u.output, c: u.cached });
  const t = String(r.message.content || '');
  let j; try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { throw new Error('建议生成失败，请重试'); }
  const ids = new Set(list.map(m => m.id)), str = (v, n) => String(v ?? '').trim().slice(0, n);
  const real = new Set(list.filter(m => m.visitors || m.reacted).map(m => m.id));
  // the model sometimes still writes ids: show names
  const names = t => list.reduce((acc, m) => acc.replace(new RegExp(`\\[?\\b${m.id}\\b\\]?`, 'g'), `「${m.name}」`), t);
  const advice = {
    ts: Date.now(), summary: names(str(j.summary, 120)), focus: ids.has(j.focus) ? j.focus : '',
    ranking: (Array.isArray(j.ranking) ? j.ranking : []).filter(x => ids.has(x?.id)).map(x => ({ id: x.id, why: names(str(x.why, 100)) })),
    park: (Array.isArray(j.park) ? j.park : []).filter(id => real.has(id)), // never "park" an idea nobody real has tried
    todo: (Array.isArray(j.todo) ? j.todo : []).map(x => names(str(x, 120))).filter(Boolean).slice(0, 4),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADVICE, JSON.stringify(advice, null, 1));
  return advice;
}
