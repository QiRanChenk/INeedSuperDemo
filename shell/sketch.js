// Design sketches: before anything is built, each design direction of a plan can be drawn as a static, high-fidelity
// HTML mock of the core screen (sd.css classes + a little CSS, realistic sample data, no scripts). The user compares
// them visually; the chosen one is saved into the project as sketch.html and the build agent follows its structure.
import fs from 'node:fs';
import path from 'node:path';
import { chat } from './llm.js';
import { logUsage } from './usagelog.js';
import { normalizeUsage } from './agent.js';
import { SDK_DIR } from './config.js';
import { normalizePlan, LOOKS, LAYOUTS } from './planner.js';

let kitDoc = null;
const kit = () => {
  if (kitDoc == null) { try { const t = fs.readFileSync(path.join(SDK_DIR, 'README.md'), 'utf8'); kitDoc = t.slice(Math.max(0, t.indexOf('## 前端组件库'))); } catch { kitDoc = ''; } }
  return kitDoc;
};

/** Strip anything executable: the sketch is shown in a sandboxed frame anyway, and later read by the agent as a reference. */
export function cleanSketch(html) {
  let t = String(html || '').replace(/^```(?:html)?\s*|\s*```\s*$/g, '').trim();
  const s = t.search(/<!doctype|<html/i); if (s > 0) t = t.slice(s);
  t = t.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '').slice(0, 80000);
  // cut off mid-way (output limit): drop the dangling partial tag and close the document, and say so for the agent
  const end = t.search(/<\/html\s*>(?![\s\S]*<\/html\s*>)/i);
  if (end >= 0) t = t.slice(0, end) + '</html>'; // drop any prose after the document
  else if (/<body/i.test(t)) t = t.replace(/<[^>]*$/, '') + '\n<!-- 草图到这里被截断（后面没有内容了），按已有部分理解即可 -->\n</body></html>';
  return t;
}

export async function makeSketch(rawPlan, index = 0, description = '') {
  const plan = normalizePlan(rawPlan);
  const d = plan.designs[index];
  if (!d) throw new Error('没有这个设计方向');
  const mobile = d.layout.split('+').includes('tabbar'); // phone-first direction: draw it at phone size
  const brief = [
    `想法：${String(description).slice(0, 1000)}`, plan.summary && `目标：${plan.summary}`, plan.hypothesis && `要验证的假设：${plan.hypothesis}`,
    plan.users.length && `使用者：${plan.users.join('、')}`,
    `核心页面：${plan.pages.map(p => `${p.name}（${p.purpose}）`).join('；')}`,
    plan.data.length && `数据：${plan.data.map(x => `${x.name}：${x.fields.join('、')}`).join('；')}`,
    plan.flows.length && `关键流程：${plan.flows.join('；')}`, plan.highlights.length && `亮点：${plan.highlights.join('；')}`,
    `设计方向：${d.name}（${d.why}）`, `设计语言：body class="sd-look-${d.look}"（${LOOKS[d.look]}）`,
    `布局：${d.layout.split('+').map(x => LAYOUTS[x]).join(' + ')}`, d.color && `主色：${d.color}（写在 body 的 style="--sd-brand: …"）`,
    d.signature.length && `行业专属元素（必须画出来）：${d.signature.join('、')}`,
  ].filter(Boolean).join('\n');
  // gateways' output moderation occasionally trips on realistic sample data (names, phone numbers, medical values): retry once
  const call = (extra = []) => chat({ thinking: false, maxTokens: 16000, temperature: 0.7, messages: [
    { role: 'system', content: `你是顶尖的产品界面设计师。为一个「验证用 Demo」画核心页面（第一个页面）的静态高保真草图：一个完整的 HTML 文档，${mobile ? '手机竖屏（宽 390px）下的样子，底部标签栏导航' : '电脑宽屏下的样子'}，让人一眼看出这是哪个行业、给谁用、价值在哪。
要求：
- <head> 里只引入 <link rel="stylesheet" href="_sd/sd.css">，再加一个 <style> 写这个方向专属的样式；不要 <script>、不要外部字体/图片/CDN（图标用 emoji 或 CSS 画）。
- 用组件库的类（下面的文档）搭骨架，按设计方向定布局和气质，专属元素要做得像真的；不要套「标题 + 4 指标卡 + 表格」的固定模式，除非它确实是最好的表达。
- 导航只放方案里的页面（1-2 个），不要画方案外的菜单入口——Demo 只做这些。
- 写得紧凑：整份 HTML 控制在 400 行以内，样式写简洁，列表 6-8 条就够，重复结构不要写太多条；一定要写完整，以 </html> 结尾。
- 示例数据要像真实业务（具体的人名、地名、编号、金额、时间），数量够撑满页面。界面文字全用中文业务语言，不出现技术词。
- 只输出 HTML，不要解释。
组件库文档：
${kit()}` },
    { role: 'user', content: brief }, ...extra,
  ] });
  let r;
  try { r = await call(); } catch (e) { if (!/inappropriate|sensitive|安全|审核/i.test(e.message)) throw e; r = await call(); }
  const usage = r => { const u = normalizeUsage(r.usage); if (u) logUsage({ p: '_planning', i: u.input, o: u.output, c: u.cached }); };
  usage(r);
  // models that can't switch reasoning off (e.g. glm-5.3) spend the whole budget thinking (even 32k tokens / 9 minutes
  // didn't produce a sketch in testing): say so instead of retrying
  if (!/<body/i.test(String(r.message.content || '')) && r.message.reasoning_content) throw new Error('当前模型无法关闭深度思考，画草图会把输出额度全用在思考上。可以跳过草图直接确认方案，或在模型设置里换成 deepseek / qwen 系列再画');
  // gateways cap one answer (~8k tokens here): continue from where it stopped, up to twice
  let out = String(r.message.content || '').replace(/\s*```\s*$/, '');
  for (let k = 0; k < 2 && /<body/i.test(out) && !/<\/html\s*>/i.test(out); k++) {
    const c = await call([{ role: 'assistant', content: out }, { role: 'user', content: '输出被截断了。从上面最后一个字符处接着往下写，直接输出剩余的 HTML（不要重复已经写过的内容，不要代码块标记，不要解释），写到 </html> 结束。' }]);
    usage(c);
    out += String(c.message.content || '').replace(/^```(?:html)?\s*/, '').replace(/\s*```\s*$/, '');
  }
  const html = cleanSketch(out);
  if (!/<body/i.test(html)) throw new Error('草图生成失败，请重试');
  return { html, device: mobile ? 'mobile' : 'desktop' };
}
