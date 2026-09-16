import { getSettings } from './config.js';

/** One chat-completions call against any OpenAI-compatible endpoint. Returns the assistant message. */
export async function chat({ messages, tools, temperature, settings }) {
  const s = settings || getSettings();
  if (!s.baseUrl || !s.model) throw new Error('LLM 未配置：请先在设置中填写 Base URL / Model / API Key');

  const body = { model: s.model, messages, temperature: temperature ?? s.temperature, stream: false };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  let res;
  try {
    res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }

  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('LLM 返回非 JSON: ' + text.slice(0, 200)); }
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LLM 返回无 choices: ' + text.slice(0, 200));
  return { message: msg, usage: data.usage || null };
}

export async function testConnection(settings) {
  const t0 = Date.now();
  const { message } = await chat({ settings, messages: [{ role: 'user', content: '回复 OK' }], temperature: 0 });
  return { ok: true, ms: Date.now() - t0, reply: String(message.content || '').slice(0, 50) };
}
