// Plan first: turn a one-line business request into a reviewable plan (pages, data, flows, sample data, skeleton)
// before anything is built. The confirmed plan becomes the first message of the project's conversation.
import { chat } from './llm.js';
import { logUsage } from './usagelog.js';
import { normalizeUsage } from './agent.js';
import { SKELETONS, listProjects } from './registry.js';

export const LOOKS = { clean: '干净通用', industrial: '工业现场', warm: '温暖服务', bold: '活力醒目', editorial: '克制专业', compact: '紧凑数据' };
export const LAYOUTS = { topbar: '顶栏', sidebar: '侧边栏应用', tabbar: '手机底部标签', hero: '首屏横幅', board: '状态墙' };

const SYSTEM = `你是资深的产品顾问，帮业务人员把一句话想法变成一个「验证用 Demo」的方案。它的目的不是做成能落地的系统，而是用最少的东西让目标用户一看就明白、亲手试一次，从而判断这个想法值不值得继续做。Demo 是 Web 页面（电脑和手机都能用）。
只输出一个 JSON 对象，不要任何解释或代码块标记。字段：
{
  "name": "项目名，具体、面向业务，不超过 10 个汉字，不带"系统/平台/Demo"后缀",
  "hypothesis": "这个 Demo 要验证的核心假设，一句话，如：店长愿意每天花 1 分钟录库存来换取缺货预警",
  "signals": ["问试用者的 2-3 个验证问题，用来判断假设是否成立，口语化，如：你现在怎么知道哪些货快卖完了？这个提醒能替代你现在的做法吗？"],
  "skeleton": "起步骨架，从 ${Object.keys(SKELETONS).join(' / ')} 中选最接近的：${Object.entries(SKELETONS).map(([k, v]) => `${k}=${v.label}（${v.fit}）`).join('；')}",
  "summary": "一句话说明这个 Demo 解决谁的什么问题",
  "users": ["使用者角色，1-3 个"],
  "pages": [{ "name": "页面名", "purpose": "这个页面能做什么，一句话" }],
  "data": [{ "name": "数据对象，如 客户", "fields": ["字段（必填的加 *），如 姓名*", "电话", "等级（A/B/C）"] }],
  "flows": ["关键使用流程，每条一句，按用户视角写，如：销售新增客户 → 记录拜访 → 主管在看板查看转化"],
  "sampleData": "准备什么样的示例数据让 Demo 看起来真实（数量、分布、时间跨度）",
  "highlights": ["让演示出彩的 1-3 个点，可包含 AI 能力，如：AI 自动总结拜访记录"],
  "outOfScope": ["这一版先不做的，避免范围过大，如：登录与权限、短信通知"],
  "designs": [{
    "name": "设计方向名，4-8 字，如：车间看板风",
    "why": "为什么适合：从行业气质、谁在什么场景用（设备、光线、时长、是否给客户看）推导，一句话",
    "look": "设计语言，从 ${Object.keys(LOOKS).join(' / ')} 选一个",
    "layout": "布局，从 ${Object.keys(LAYOUTS).join(' / ')} 选 1-2 个，用 + 连接，如 sidebar+board",
    "color": "主色及理由，如：安全橙 #f59e0b（车间警示色）",
    "signature": ["这个行业专属的界面元素 2-3 个，如：设备状态墙、扫码大按钮、可打印报价单、桌台平面图"]
  }]
}
designs 给 2-3 个明显不同的设计方向（设计语言、布局、专属元素都要有区别），第一个是最推荐的；它们必须来自对行业和使用场景的推导，不是随机风格，也不要只是换颜色。
要求：这是验证版，只做 1 个核心场景——让人最快感受到价值的那一下（「啊哈时刻」）。页面 1-2 个、流程 1-3 条、数据对象 1-2 个；完整的增删改查、导出、权限、设置、统计报表等都放进 outOfScope，除非它就是核心价值。示例数据可以是预置的，但要贴近真实；不要写技术实现（数据库、接口、框架）；全部用中文。`;

/** description -> plan object. Throws on LLM failure. */
/** look+layout of the most recent plans, so the planner can steer away from repeating itself. */
function recentDesigns(n = 6) {
  return listProjects().filter(p => p.plan?.designs?.length).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, n)
    .map(p => { const d = p.plan.designs[p.plan.design || 0] || p.plan.designs[0]; return `${p.name}：${d.look} + ${d.layout}`; });
}

export async function makePlan(description) {
  const recent = recentDesigns();
  const user = String(description).slice(0, 4000) + (recent.length ? `\n\n（最近其他项目用过的设计：${recent.join('；')}。若别的方向同样合适，优先换一种，避免所有 Demo 长得一样；行业确实最适合同一种时可以重复。）` : '');
  const r = await chat({ temperature: 0.6, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] });
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
    hypothesis: String(p.hypothesis || '').trim().slice(0, 200),
    signals: strList(p.signals, 4),
    designs: (Array.isArray(p.designs) ? p.designs : []).slice(0, 3).map(d => ({
      name: String(d?.name || '').trim().slice(0, 20), why: String(d?.why || '').trim().slice(0, 200),
      look: LOOKS[d?.look] ? d.look : 'clean',
      layout: String(d?.layout || 'topbar').split(/[+＋,，\s]+/).filter(x => LAYOUTS[x]).slice(0, 2).join('+') || 'topbar',
      color: String(d?.color || '').trim().slice(0, 60), signature: strList(d?.signature, 4),
    })).filter(d => d.name),
    design: Math.max(0, Number.isInteger(p.design) ? p.design : 0),
  };
}

/** The chosen design direction (or null). */
export const chosenDesign = p => p.designs?.[Math.min(p.design || 0, (p.designs?.length || 1) - 1)] || null;
const designText = d => [
  `- 方向：${d.name}${d.why ? `（${d.why}）` : ''}`,
  `- 设计语言：body 加 class sd-look-${d.look}（${LOOKS[d.look]}）${d.look === 'clean' ? '，即默认样式' : ''}`,
  `- 布局：${d.layout.split('+').map(x => LAYOUTS[x]).join(' + ')}`,
  d.color && `- 主色：${d.color}（写在 body { --sd-brand: … }）`,
  d.signature.length && `- 行业专属元素（必须做出来）：${d.signature.join('、')}`,
].filter(Boolean);

/** The confirmed plan as the first instruction to the build agent. */
export function planToMessage(plan, description) {
  const p = normalizePlan(plan);
  const sec = (title, lines) => (lines.length ? `## ${title}\n${lines.join('\n')}\n` : '');
  return [
    `请按下面已经和用户确认的方案，把这个项目改造成一个「验证用 Demo」（当前起步骨架：${SKELETONS[p.skeleton].label}，可以大胆改，不需要保留骨架里的示例业务，用不上的页面和代码直接删掉）。`,
    '它的目的不是做成能落地的系统，而是让目标用户一看就懂、亲手试一次核心场景，从而判断想法是否成立。把核心那一下做到位、做得可信，其余一律从简。',
    `用户原话：${description}`,
    '',
    sec('目标', [p.summary].filter(Boolean)),
    sec('要验证的假设', [p.hypothesis].filter(Boolean)),
    sec('使用者', p.users.map(x => `- ${x}`)),
    sec('页面', p.pages.map(x => `- ${x.name}：${x.purpose}`)),
    sec('数据', p.data.map(d => `- ${d.name}：${d.fields.join('、')}`)),
    sec('关键流程', p.flows.map((x, i) => `${i + 1}. ${x}`)),
    sec('示例数据', [p.sampleData].filter(Boolean)),
    sec('演示亮点', p.highlights.map(x => `- ${x}`)),
    sec('这一版不做', p.outOfScope.map(x => `- ${x}`)),
    sec('设计方向（已确认）', chosenDesign(p) ? [...designText(chosenDesign(p)), '- 按 SDK 文档「设计方向要求」实现：先定布局和专属元素，颜色最后；不要套「标题 + 4 指标卡 + 表格」的固定模式，除非它确实是这个方向最好的表达。'] : []),
    sec('用户补充', [p.notes].filter(Boolean)),
    '## 工作方式（请照做，速度优先，目标 25 步左右、5 分钟内完成）',
    '1. 快速看一眼骨架的 server.js 和页面（SDK 用法看系统提示里的文档，不要读 sdk/ 源码），然后一次写好后端：只要核心场景需要的表、接口和示例数据；示例数据贴近业务即可，用 http_request 校验一次，不要反复打磨。',
    '2. 写页面：1-2 个页面，每个一次写完整；不做完整的增删改查、导出、权限、设置；方案外的功能不要加（想到的好点子写进总结作为下一步建议）。',
    '3. 用 page_view 看电脑效果、page_act 走通关键流程（弹窗里的字段用 label 定位，一次调用完成点开-填写-保存），再用 page_view 的 device="mobile" 看手机效果，有问题就修。',
    '4. 简短总结：做了什么、怎么演示、建议的下一步。',
    '完成标准：核心场景能亲手走通一遍、数据看起来真实、电脑和手机都看过；不追求功能完整。',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}
