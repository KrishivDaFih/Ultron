'use strict';
/**
 * Provider layer — one neutral chat interface over three APIs.
 *
 *   Groq       : OpenAI-compatible  (https://api.groq.com/openai/v1)
 *   OpenAI     : OpenAI             (https://api.openai.com/v1)
 *   Anthropic  : Messages API       (https://api.anthropic.com/v1)
 *
 * Neutral message shape used by the rest of the app:
 *   { role:'user',      content:'...', images?:[{media_type,data}] }
 *   { role:'assistant', content:'...', toolCalls?:[{id,name,input}] }
 *   { role:'tool',      toolCallId, name, content:'...' }
 */

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1'
};

const LABELS = { groq: 'Groq', openai: 'OpenAI', anthropic: 'Anthropic' };

/* ------------------------------------------------------------------ */
/* model discovery — asked live so the list is never stale             */
/* ------------------------------------------------------------------ */
async function listModels(provider, key) {
  if (!key) throw new Error('No API key set for ' + (LABELS[provider] || provider) + '.');
  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: 'Bearer ' + key };

  const res = await fetch(ENDPOINTS[provider] + '/models', { headers });
  if (!res.ok) throw new Error(await describeError(res));
  const json = await res.json();
  const rows = json.data || json.models || [];
  return rows
    .map(m => (typeof m === 'string' ? m : m.id))
    .filter(Boolean)
    .sort();
}

async function describeError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = (body.error && (body.error.message || body.error.type)) || JSON.stringify(body).slice(0, 300);
  } catch (e) {
    try { detail = (await res.text()).slice(0, 300); } catch (e2) { detail = ''; }
  }
  if (res.status === 401) return 'Key rejected (401). Check the API key for this provider.';
  if (res.status === 404) return 'Model not found (404). ' + detail;
  if (res.status === 429) return 'Rate limited (429). ' + detail;
  return 'HTTP ' + res.status + '. ' + detail;
}

/* ------------------------------------------------------------------ */
/* SSE reader                                                          */
/* ------------------------------------------------------------------ */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = null, data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data || data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch (e) { continue; }
      onEvent(event || parsed.type, parsed);
    }
  }
}

/* ------------------------------------------------------------------ */
/* message translation                                                 */
/* ------------------------------------------------------------------ */
function toOpenAI(messages, system) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content || '') });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls && m.toolCalls.length) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls.map(t => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) }
        }));
      }
      out.push(msg);
    } else if (m.images && m.images.length) {
      const parts = m.images.map(img => ({
        type: 'image_url',
        image_url: { url: 'data:' + img.media_type + ';base64,' + img.data }
      }));
      parts.push({ type: 'text', text: m.content || '' });
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: 'user', content: m.content || '' });
    }
  }
  return out;
}

function toAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content || '') }]
      });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '…' }] });
    } else {
      const blocks = [];
      for (const img of m.images || []) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
      blocks.push({ type: 'text', text: m.content || '' });
      out.push({ role: 'user', content: blocks });
    }
  }
  // the Messages API will not accept two adjacent user turns carrying tool results
  return out;
}

/* ------------------------------------------------------------------ */
/* the call                                                            */
/* ------------------------------------------------------------------ */
async function chat(opts) {
  const { provider, model, key, system, messages, tools, temperature, maxTokens, onDelta, signal } = opts;
  if (!key) throw new Error('No API key set for ' + (LABELS[provider] || provider) + '. Open Settings.');

  return provider === 'anthropic'
    ? anthropicChat(opts)
    : openAIChat(opts);
}

async function openAIChat({ provider, model, key, system, messages, tools, temperature, maxTokens, onDelta, signal }) {
  const base = ENDPOINTS[provider];
  const body = {
    model,
    messages: toOpenAI(messages, system),
    stream: true,
    temperature
  };
  if (provider === 'openai') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    body.tool_choice = 'auto';
  }

  let res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal
  });

  // tolerate models that reject temperature or the newer token parameter
  if (!res.ok && res.status === 400) {
    const msg = await res.clone().text().catch(() => '');
    const retry = Object.assign({}, body);
    let changed = false;
    if (/temperature/i.test(msg)) { delete retry.temperature; changed = true; }
    if (/max_completion_tokens|max_tokens/i.test(msg)) {
      delete retry.max_completion_tokens;
      retry.max_tokens = maxTokens;
      changed = true;
    }
    if (changed) {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(retry),
        signal
      });
    }
  }
  if (!res.ok) throw new Error(await describeError(res));

  let text = '';
  const calls = [];        // index -> {id,name,args}
  let stopReason = 'stop';

  await readSSE(res, (_evt, data) => {
    const choice = data.choices && data.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) { text += delta.content; onDelta && onDelta(delta.content, text); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index == null ? 0 : tc.index;
      if (!calls[i]) calls[i] = { id: tc.id || 'call_' + i, name: '', args: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function && tc.function.name) calls[i].name += tc.function.name;
      if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  });

  return {
    text,
    stopReason,
    toolCalls: calls.filter(Boolean).map(c => ({ id: c.id, name: c.name, input: safeJSON(c.args) }))
  };
}

async function anthropicChat({ model, key, system, messages, tools, temperature, maxTokens, onDelta, signal }) {
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: toAnthropic(messages),
    stream: true
  };
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }

  const res = await fetch(ENDPOINTS.anthropic + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new Error(await describeError(res));

  let text = '';
  let stopReason = 'stop';
  const blocks = {};      // index -> {type,id,name,json}

  await readSSE(res, (evt, data) => {
    if (evt === 'content_block_start') {
      const b = data.content_block || {};
      blocks[data.index] = { type: b.type, id: b.id, name: b.name, json: '' };
    } else if (evt === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type === 'text_delta') { text += d.text; onDelta && onDelta(d.text, text); }
      else if (d.type === 'input_json_delta' && blocks[data.index]) blocks[data.index].json += d.partial_json;
    } else if (evt === 'message_delta') {
      if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
    } else if (evt === 'error') {
      throw new Error((data.error && data.error.message) || 'Anthropic stream error.');
    }
  });

  const toolCalls = Object.values(blocks)
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: safeJSON(b.json) }));

  return { text, stopReason: toolCalls.length ? 'tool_calls' : stopReason, toolCalls };
}

function safeJSON(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch (e) { return {}; }
}

module.exports = { chat, listModels, LABELS, ENDPOINTS };
