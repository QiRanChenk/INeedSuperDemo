// Plan first: turn a one-line business request into a reviewable plan (pages, data, flows, sample data, skeleton)
// before anything is built. The confirmed plan becomes the first message of the project's conversation.
import { chat } from './llm.js';
import { logUsage } from './usagelog.js';
import { normalizeUsage } from './agent.js';
import { SKELETONS } from './registry.js';

const SYSTEM = `你是资深的产品顾问，帮业务人员把一句话想法变成可以马上动手做的 Demo 方案。Demo 是一个 Web 应用（电脑和手机都能用），用于验证想法、给客户或同事演示。
只输出一个 JSON 对象，不要任何解释或代码块标记。字段：
{
  "name": "项目名，具体、面向业务，不超过 10 个汉字，不带"系统/平台/Demo"后缀",
  "skeleton": "起步骨架，从 ${Object.keys(SKELETONS).join(' / ')} 中选最接近的：${Object.entries(SKELETONS).map(([k, v]) => `${k}=${v.label}（${v.fit}）`).join('；')}",
  "summary": "一句话说明这个 Demo 解决谁的什么问题",
  "users": ["使用者角色，1-3 个"],
  "pages": [{ "name": "页面名", "purpose": "这个页面能做什么，一句话" }],
  "data": [{ "name": "数据对象，如 客户", "fields": ["字段（必填的加 *），如 姓名*", "电话", "等级（A/B/C）"] }],
  "flows": ["关键使用流程，每条一句，按用户视角写，如：销售新增客户 → 记录拜访 → 主管在看板查看转化"],
  "sampleData": "准备什么样的示例数据让 Demo 看起来真实（数量、分布、时间跨度）",
  "highlights": ["让演示出彩的 1-3 个点，可包含 AI 能力，如：AI 自动总结拜访记录"],
  "outOfScope": ["这一版先不做的，避免范围过大，如：登录与权限、短信通知"]
}
要求：页面 2-5 个、流程 2-5 条、数据对象 1-4 个，围绕最核心的价值，宁少勿滥；不要写技术实现（数据库、接口、框架）；全部用中文。`;

/** description -> plan object. Throws on LLM failure. */
export async function makePlan(description) {
  const r = await chat({ temperature: 0.4, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(description).slice(0, 4000) }] });
  const u = normalizeUsage(r.usage);
  if (u) logUsage({ p: '_planning', i: u.input, o: u.output, c: u.cached });
  return normalizePlan(parseJson(r.message.content || ''));
}

function parseJson(text) {
  const t = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  try { return JSON.parse(t.slice(s, e + 1)); } catch { throw new Error('方案生成失败：模型没有返回有效的方案，请重试'); }
}

const strList = (v, n = 8) => (Array.isArray(v) ? v : []).map(x => String(typeof x === 'object' ? JSON.stringify(x) : x ?? '').trim()).filter(Boolean).slice(0, n);

export function normalizePlan(p = {}) {
  return {
    name: String(p.name || '').trim().slice(0, 20),
    skeleton: SKELETONS[p.skeleton] ? p.skeleton : 'blank',
    summary: String(p.summary || '').trim(),
    users: strList(p.users, 4),
    pages: (Array.isArray(p.pages) ? p.pages : []).slice(0, 8).map(x => ({ name: String(x?.name || x || '').trim(), purpose: String(x?.purpose || '').trim() })).filter(x => x.name),
    data: (Array.isArray(p.data) ? p.data : []).slice(0, 6).map(x => ({ name: String(x?.name || '').trim(), fields: strList(x?.fields, 20) })).filter(x => x.name),
    flows: strList(p.flows),
    sampleData: String(p.sampleData || '').trim(),
    highlights: strList(p.highlights, 4),
    outOfScope: strList(p.outOfScope, 6),
    notes: String(p.notes || '').trim(),
  };
}

/** The confirmed plan as the first instruction to the build agent. */
export function planToMessage(plan, description) {
  const p = normalizePlan(plan);
  const sec = (title, lines) => (lines.length ? `## ${title}\n${lines.join('\n')}\n` : '');
  return [
    `请按下面已经和用户确认的方案，把这个项目改造成可演示的 Demo（当前起步骨架：${SKELETONS[p.skeleton].label}，可以大胆改，不需要保留骨架里的示例业务）。`,
    `用户原话：${description}`,
    '',
    sec('目标', [p.summary].filter(Boolean)),
    sec('使用者', p.users.map(x => `- ${x}`)),
    sec('页面', p.pages.map(x => `- ${x.name}：${x.purpose}`)),
    sec('数据', p.data.map(d => `- ${d.name}：${d.fields.join('、')}`)),
    sec('关键流程', p.flows.map((x, i) => `${i + 1}. ${x}`)),
    sec('示例数据', [p.sampleData].filter(Boolean)),
    sec('演示亮点', p.highlights.map(x => `- ${x}`)),
    sec('这一版不做', p.outOfScope.map(x => `- ${x}`)),
    sec('用户补充', [p.notes].filter(Boolean)),
    '完成标准：每个页面都能用、关键流程能走通、有贴近业务的示例数据；用 page_view 在电脑和手机（device=mobile）两种尺寸下检查过观感；最后简短说明做了什么、怎么演示。',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}
