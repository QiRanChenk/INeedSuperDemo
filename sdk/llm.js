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

// In-app AI should answer fast: "thinking" (reasoning) is switched off unless a call asks for it with { thinking: true }.
// Providers name the switch differently (Qwen/DashScope: enable_thinking, GLM/DeepSeek gateways: thinking.type); if a
// model rejects these fields (e.g. glm-5.3 only allows thinking) we stop sending them to that model.
const THINKING_OFF = { enable_thinking: false, thinking: { type: 'disabled' } };
const noThinkingSwitch = new Set(); // models that reject the switch
const DEFAULT_TIMEOUT = 90_000;

/**
 * One chat-completions call.
 * Returns { message, usage, ms, model, id, finishReason }:
 *   message      assistant message (OpenAI format: content / tool_calls / reasoning_content)
 *   usage        { input, output, cached, total, raw } or null if the provider sent none
 *   ms           wall-clock time of the request
 *   model / id   as reported by the provider
 * opts: { temperature, model, tools, maxTokens, signal, onUsage, thinking (default false), timeoutMs (default 90 s) }
 * opts.onUsage(usage, meta) fires after the call (also reachable from complete / completeJSON).
 */
async function chat(messages, { temperature = 0.4, model, tools, maxTokens, signal, onUsage, thinking = false, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const c = cfg();
  if (!c.baseUrl || !c.model) throw new Error('LLM not configured (SUPERDEMO_LLM_BASE_URL / SUPERDEMO_LLM_MODEL)');
  const body = { model: model || c.model, messages, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (maxTokens) body.max_tokens = maxTokens;
  const send = async withSwitch => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify(withSwitch ? { ...body, ...THINKING_OFF } : body),
      });
    } catch (e) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      throw e;
    }
  };
  const t0 = Date.now();
  const switchOff = !thinking && !noThinkingSwitch.has(body.model);
  let res = await send(switchOff), text = await res.text();
  if (switchOff && res.status === 400 && /thinking|unrecognized|unknown|extra|not permitted|additional/i.test(text)) {
    noThinkingSwitch.add(body.model); // this model doesn't take the switch: plain requests from now on
    res = await send(false); text = await res.text();
  }
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

/** Simple prompt -> string. Pass opts.onUsage to observe token usage. Throws a readable error when the model returned no text. */
async function complete(prompt, opts = {}) {
  const msgs = opts.system ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  const { message, finishReason } = await chat(msgs, opts);
  const text = message.content || '';
  if (!text.trim() && !message.tool_calls?.length) {
    const why = message.reasoning_content ? '模型把输出额度都用在了思考上' : '模型返回了空内容';
    throw new Error(`AI 没有给出结果（${why}，finish_reason=${finishReason}）。可调大 maxTokens 或缩短输入`);
  }
  return text;
}

/** Prompt -> parsed JSON (object or array; tolerates ```json fences and text around it). */
async function completeJSON(prompt, opts = {}) {
  const raw = await complete(prompt + '\n\n只输出 JSON，不要其他文字。', { temperature: 0.1, ...opts });
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(body); } catch {}
  const s = body.search(/[{[]/), e = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (s >= 0 && e > s) { try { return JSON.parse(body.slice(s, e + 1)); } catch {} }
  throw new Error('AI 返回的内容不是有效的 JSON：' + body.slice(0, 120));
}

export const llm = {
  chat, complete, completeJSON,
  isConfigured: () => !!(cfg().baseUrl && cfg().model),
  config: () => ({ ...cfg(), apiKey: cfg().apiKey ? '***' : '' }),
  /** Accumulated usage of every call in this process: { input, output, cached, total, calls, ms }. */
  stats: () => ({ ...stats }),
  resetStats: () => { stats = emptyStats(); },
};
