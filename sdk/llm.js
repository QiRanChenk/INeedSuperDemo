// OpenAI-compatible chat client driven by env vars injected by the shell (or a .env when deployed standalone).
const cfg = () => ({
  baseUrl: (process.env.SUPERDEMO_LLM_BASE_URL || process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.SUPERDEMO_LLM_API_KEY || process.env.LLM_API_KEY || '',
  model: process.env.SUPERDEMO_LLM_MODEL || process.env.LLM_MODEL || '',
});

// Process-wide token accounting across every call made through this module.
const emptyStats = () => ({ input: 0, output: 0, cached: 0, total: 0, calls: 0, ms: 0 });
let stats = emptyStats();

/** Normalize OpenAI / DeepSeek / Qwen / GLM usage shapes into { input, output, cached, total, raw }. */
export function normalizeUsage(u) {
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  return { input, output, cached, total: u.total_tokens ?? input + output, raw: u };
}

function record(usage, ms) {
  stats.calls += 1; stats.ms += ms;
  if (usage) { stats.input += usage.input; stats.output += usage.output; stats.cached += usage.cached; stats.total += usage.total; }
}

/**
 * One chat-completions call.
 * Returns { message, usage, ms, model, id, finishReason }:
 *   message      assistant message (OpenAI format: content / tool_calls / reasoning_content)
 *   usage        { input, output, cached, total, raw } or null if the provider sent none
 *   ms           wall-clock time of the request
 *   model / id   as reported by the provider
 * opts.onUsage(usage, meta) fires after the call (also reachable from complete / completeJSON).
 */
async function chat(messages, { temperature = 0.4, model, tools, maxTokens, signal, onUsage } = {}) {
  const c = cfg();
  if (!c.baseUrl || !c.model) throw new Error('LLM not configured (SUPERDEMO_LLM_BASE_URL / SUPERDEMO_LLM_MODEL)');
  const body = { model: model || c.model, messages, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (maxTokens) body.max_tokens = maxTokens;
  const t0 = Date.now();
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const ms = Date.now() - t0;
  const choice = data.choices?.[0];
  const usage = normalizeUsage(data.usage);
  record(usage, ms);
  const result = { message: choice?.message ?? { role: 'assistant', content: '' }, usage, ms, model: data.model || body.model, id: data.id ?? null, finishReason: choice?.finish_reason ?? null };
  if (onUsage) { try { onUsage(usage, result); } catch {} }
  return result;
}

/** Simple prompt -> string. Pass opts.onUsage to observe token usage. */
async function complete(prompt, opts = {}) {
  const msgs = opts.system ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  const { message } = await chat(msgs, opts);
  return message.content || '';
}

/** Prompt -> parsed JSON object (tolerates ```json fences). Pass opts.onUsage to observe token usage. */
async function completeJSON(prompt, opts = {}) {
  const raw = await complete(prompt + '\n\n只输出 JSON，不要其他文字。', { temperature: 0.1, ...opts });
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  return JSON.parse(m[1].trim());
}

export const llm = {
  chat, complete, completeJSON,
  isConfigured: () => !!(cfg().baseUrl && cfg().model),
  config: () => ({ ...cfg(), apiKey: cfg().apiKey ? '***' : '' }),
  /** Accumulated usage of every call in this process: { input, output, cached, total, calls, ms }. */
  stats: () => ({ ...stats }),
  resetStats: () => { stats = emptyStats(); },
};
