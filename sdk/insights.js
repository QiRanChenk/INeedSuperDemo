import { llm } from './llm.js';

export const DEFAULT_DIRECTIONS = [
  { id: 'growth', label: '增长机会', hint: '哪些维度（地区/产品/渠道/时段）表现最好，值得加码？' },
  { id: 'risk', label: '风险预警', hint: '哪些指标在下滑、异常或波动大，需要关注？' },
  { id: 'cost', label: '成本优化', hint: '哪里毛利低、成本高、效率差，可如何改善？' },
  { id: 'customer', label: '客户洞察', hint: '客户/渠道结构有何特征，如何更好服务？' },
  { id: 'action', label: '下一步行动', hint: '给出 3 条可立刻执行的具体建议。' },
];

/** Pure-JS profile of a table so the LLM gets facts, not 10k rows. */
export function summarizeTable({ columns, rows }, { sample = 8, topK = 6 } = {}) {
  const profile = { rowCount: rows.length, columns: [] };
  for (const col of columns) {
    const vals = rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== '');
    const nums = vals.filter(v => typeof v === 'number');
    const info = { name: col, nonNull: vals.length };
    if (nums.length && nums.length >= vals.length * 0.8) {
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      info.type = 'number';
      info.min = sorted[0]; info.max = sorted[sorted.length - 1];
      info.mean = round(sum / nums.length); info.sum = round(sum);
      info.median = sorted[Math.floor(sorted.length / 2)];
    } else {
      const counts = new Map();
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      info.type = looksLikeDate(vals) ? 'date' : 'category';
      info.distinct = counts.size;
      info.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([v, n]) => ({ value: v, count: n }));
      if (info.type === 'date') { const ds = vals.map(String).sort(); info.min = ds[0]; info.max = ds[ds.length - 1]; }
    }
    profile.columns.push(info);
  }
  // group-by aggregates: every category column x every numeric column (sum), top K
  profile.aggregates = [];
  const cats = profile.columns.filter(c => c.type === 'category' && c.distinct <= 30);
  const nums = profile.columns.filter(c => c.type === 'number');
  for (const c of cats) for (const n of nums) {
    const g = new Map();
    for (const r of rows) if (typeof r[n.name] === 'number') g.set(String(r[c.name]), (g.get(String(r[c.name])) || 0) + r[n.name]);
    profile.aggregates.push({ by: c.name, metric: n.name, op: 'sum',
      top: [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([k, v]) => ({ key: k, value: round(v) })) });
  }
  // time series by month if a date column exists
  const dateCol = profile.columns.find(c => c.type === 'date');
  if (dateCol) {
    profile.timeseries = [];
    for (const n of nums) {
      const g = new Map();
      for (const r of rows) { const k = String(r[dateCol.name]).slice(0, 7); if (typeof r[n.name] === 'number') g.set(k, (g.get(k) || 0) + r[n.name]); }
      profile.timeseries.push({ by: dateCol.name + ' (month)', metric: n.name, points: [...g.entries()].sort().map(([k, v]) => ({ period: k, value: round(v) })) });
    }
  }
  profile.sample = rows.slice(0, sample);
  return profile;
}

/**
 * analyze({ table, question, directions, context }) -> { markdown, profile }
 * directions: array of ids from DEFAULT_DIRECTIONS or custom { id, label, hint } objects.
 */
export async function analyze({ table, question = '', directions = ['growth', 'risk', 'action'], context = '', language = '中文' }) {
  const profile = summarizeTable(table);
  const dirs = directions.map(d => typeof d === 'string' ? DEFAULT_DIRECTIONS.find(x => x.id === d) : d).filter(Boolean);
  const system = `你是一位面向业务人员的数据分析顾问。用户不懂技术，请用${language}、通俗、阅读友好的方式输出 Markdown：
- 先用 2-3 句话给出「一眼结论」
- 然后按要求的建议方向分节，每节先说数据事实（引用具体数字），再给建议
- 用短句、小标题、列表；数字保留合理精度；不要编造数据中不存在的信息
- 若数据不足以支持某个方向，坦白说明`;
  const user = `# 数据画像（由程序统计，可信）
${JSON.stringify(profile, null, 1)}

# 业务背景
${context || '（无）'}

# 用户问题
${question || '请给出整体分析。'}

# 需要覆盖的建议方向
${dirs.map(d => `- ${d.label}：${d.hint}`).join('\n') || '- 综合分析'}`;
  const markdown = await llm.complete(user, { system, temperature: 0.4 });
  return { markdown, profile };
}

const round = n => Math.round(n * 100) / 100;
const looksLikeDate = vals => vals.length > 0 && vals.slice(0, 20).every(v => /^\d{4}-\d{2}(-\d{2})?/.test(String(v)));
