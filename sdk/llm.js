// OpenAI-compatible chat client driven by env vars injected by the shell (or a .env when deployed standalone).
const cfg = () => ({
  baseUrl: (process.env.SUPERDEMO_LLM_BASE_URL || process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.SUPERDEMO_LLM_API_KEY || process.env.LLM_API_KEY || '',
  model: process.env.SUPERDEMO_LLM_MODEL || process.env.LLM_MODEL || '',
});

async function chat(messages, { temperature = 0.4, model, tools, maxTokens, signal } = {}) {
  const c = cfg();
  if (!c.baseUrl || !c.model) throw new Error('LLM not configured (SUPERDEMO_LLM_BASE_URL / SUPERDEMO_LLM_MODEL)');
  const body = { model: model || c.model, messages, temperature };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (maxTokens) body.max_tokens = maxTokens;
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
}

/** Simple prompt -> string. */
async function complete(prompt, opts = {}) {
  const msgs = opts.system ? [{ role: 'system', content: opts.system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  const m = await chat(msgs, opts);
  return m.content || '';
}

/** Prompt -> parsed JSON object (tolerates ```json fences). */
async function completeJSON(prompt, opts = {}) {
  const raw = await complete(prompt + '\n\n只输出 JSON，不要其他文字。', { temperature: 0.1, ...opts });
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  return JSON.parse(m[1].trim());
}

export const llm = { chat, complete, completeJSON, isConfigured: () => !!(cfg().baseUrl && cfg().model), config: () => ({ ...cfg(), apiKey: cfg().apiKey ? '***' : '' }) };
