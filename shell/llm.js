import { getSettings } from './config.js';

const IDLE_TIMEOUT = 120_000;   // streaming: abort if no bytes arrive for this long
const TOTAL_TIMEOUT = 180_000;  // non-streaming: whole request

/** Thrown when the caller aborted the request via `signal` (user pressed stop). */
export class StoppedError extends Error { constructor() { super('已停止'); this.name = 'StoppedError'; this.stopped = true; } }

/**
 * One chat-completions call against any OpenAI-compatible endpoint.
 * Streams by default (settings.stream !== false); onDelta({ content?, reasoning? }) fires per chunk.
 * Returns { message, usage, ms, ttft, aborted } — ms = whole request, ttft = time to first token (streaming only).
 * `signal` (optional AbortSignal) lets the caller stop the call: while streaming, the partial message collected so far is
 * returned with aborted=true; before the first byte a StoppedError is thrown.
 */
// One-shot JSON/HTML tasks (plan, report, tour, pre-test, sketch) pass thinking:false: gateways that think by default are
// several times slower and may spend the answer budget on reasoning. If the provider rejects the switch, drop it for good.
const THINKING_OFF = { enable_thinking: false, thinking: { type: 'disabled' } };
const noThinkingSwitch = new Set(); // baseUrl|model that reject the switch (e.g. glm-5.3: "enable_thinking is restricted to True")

export async function chat({ messages, tools, temperature, settings, onDelta, signal, thinking, maxTokens }) {
  const s = settings || getSettings();
  if (!s.baseUrl || !s.model) throw new Error('LLM 未配置：请先在设置中填写 Base URL / Model / API Key');
  if (signal?.aborted) throw new StoppedError();
  const stream = s.stream !== false;

  const body = { model: s.model, messages, temperature: temperature ?? s.temperature, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (maxTokens) body.max_tokens = maxTokens;
  const modelKey = s.baseUrl + '|' + s.model;
  const switchOff = thinking === false && !noThinkingSwitch.has(modelKey);
  if (switchOff) Object.assign(body, THINKING_OFF);

  const t0 = Date.now();
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), stream ? IDLE_TIMEOUT : TOTAL_TIMEOUT);
  const touch = () => { if (stream) { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT); } };
  const onStop = () => ctrl.abort();
  signal?.addEventListener('abort', onStop, { once: true });
  try {
    const res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      if (switchOff && res.status === 400 && /thinking|unrecognized|unknown|extra|not permitted|additional/i.test(text)) {
        noThinkingSwitch.add(modelKey);
        clearTimeout(timer); signal?.removeEventListener('abort', onStop);
        return chat({ messages, tools, temperature, settings, onDelta, signal, maxTokens });
      }
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    // some gateways ignore stream=true and answer with plain JSON
    if (!stream || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = parseJson(await res.text());
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('LLM 返回无 choices: ' + JSON.stringify(data).slice(0, 200));
      return { message: msg, usage: data.usage || null, ms: Date.now() - t0 };
    }
    const r = await readStream(res.body, touch, onDelta, t0, signal);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw new StoppedError();
      throw new Error(stream ? `LLM 流式响应 ${IDLE_TIMEOUT / 1000}s 无数据，已中断` : `LLM 请求超时（${TOTAL_TIMEOUT / 1000}s）`);
    }
    throw e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onStop); }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('LLM 返回非 JSON: ' + text.slice(0, 200)); }
}

/**
 * Consume an OpenAI-style SSE stream and assemble the final message (content, reasoning_content, tool_calls) + usage.
 * If `signal` aborts mid-stream, returns what has been collected so far with aborted=true (tool_calls dropped: their
 * arguments may be truncated JSON).
 */
async function readStream(bodyStream, touch, onDelta, t0, signal) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];   // by index
  let usage = null, ttft = null, reasoning = '', finish = null, aborted = false;
  const reader = bodyStream.getReader(), dec = new TextDecoder();
  let buf = '';
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let j; try { j = JSON.parse(payload); } catch { return; }
    if (j.error) throw new Error('LLM 流式错误: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 300));
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0]; if (!ch) return;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {}; const ev = {};
    if (d.content) { if (ttft == null) ttft = Date.now() - t0; message.content += d.content; ev.content = d.content; }
    if (d.reasoning_content) { if (ttft == null) ttft = Date.now() - t0; reasoning += d.reasoning_content; ev.reasoning = d.reasoning_content; }
    for (const tc of d.tool_calls || []) {
      if (ttft == null) ttft = Date.now() - t0;
      const i = tc.index ?? toolCalls.length;
      const cur = toolCalls[i] || (toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) cur.id = tc.id;
      if (tc.type) cur.type = tc.type;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
    if (onDelta && (ev.content || ev.reasoning)) onDelta(ev);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, idx).replace(/\r$/, '')); buf = buf.slice(idx + 1); }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (e.name !== 'AbortError' || !signal?.aborted) throw e;
    aborted = true;
  }
  if (reasoning) message.reasoning_content = reasoning;
  const tcs = aborted ? [] : toolCalls.filter(Boolean);
  if (tcs.length) { message.tool_calls = tcs.map((t, i) => ({ ...t, id: t.id || `call_${i}` })); }
  if (!aborted && !message.content && !tcs.length && !reasoning && !usage) throw new Error('LLM 流式返回为空' + (finish ? `（finish_reason=${finish}）` : ''));
  return { message, usage, ttft, aborted };
}

export async function testConnection(settings) {
  const t0 = Date.now();
  const { message } = await chat({ thinking: false, settings, messages: [{ role: 'user', content: '回复 OK' }], temperature: 0 });
  return { ok: true, ms: Date.now() - t0, reply: String(message.content || '').slice(0, 50) };
}
