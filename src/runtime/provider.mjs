const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class ProviderConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export class OpenAICompatibleChatProvider {
  #apiKey;
  #baseUrl;
  #model;
  #fetch;

  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model, fetchImpl = globalThis.fetch }) {
    if (!apiKey?.trim()) throw new ProviderConfigurationError('An API key is required. Open Provider settings and add one.');
    if (!model?.trim()) throw new ProviderConfigurationError('A model is required. Open Provider settings and choose one.');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.#apiKey = apiKey.trim();
    this.#baseUrl = baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
    this.#model = model.trim();
    this.#fetch = fetchImpl;
  }

  async stream(messages, { signal, onDelta, tools = [] }) {
    const request = { model: this.#model, messages, stream: true };
    if (Array.isArray(tools) && tools.length) { request.tools = tools; request.tool_choice = 'auto'; }
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      return consumeSseBody(response.body, onDelta, signal);
    }

    const payload = await response.json();
    const text = completionText(payload);
    const toolCalls = completionToolCalls(payload);
    if (!text && !toolCalls.length) throw new Error('Provider returned an empty assistant response.');
    if (text) await onDelta(text);
    return { text, toolCalls, usage: payload?.usage ?? null };
  }
}

export async function consumeSseBody(body, onDelta, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  const toolCalls = new Map();

  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = splitSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        const result = await consumeSseEvent(event, onDelta);
        mergeToolCallDeltas(toolCalls, result.toolCallDeltas);
        if (result.done) return finalizeStream(text, usage, toolCalls);
        if (result.delta) text += result.delta;
        if (result.usage) usage = result.usage;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const result = await consumeSseEvent(buffer, onDelta);
      mergeToolCallDeltas(toolCalls, result.toolCallDeltas);
      if (result.delta) text += result.delta;
      if (result.usage) usage = result.usage;
    }
  } finally {
    reader.releaseLock();
  }

  const final = finalizeStream(text, usage, toolCalls);
  if (!final.text && !final.toolCalls.length) throw new Error('Provider stream completed without text or tool calls.');
  return final;
}

export function splitSseEvents(value) {
  const normalized = value.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

async function consumeSseEvent(event, onDelta) {
  const data = event.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) return { done: false, delta: '', toolCallDeltas: [] };
  if (data === '[DONE]') return { done: true, delta: '', toolCallDeltas: [] };

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error('Provider returned malformed streaming JSON.');
  }
  const choice = payload?.choices?.[0] ?? {};
  const delta = choice?.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) await onDelta(delta);
  const toolCallDeltas = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls.map(normalizeToolCallDelta) : [];
  return {
    done: false,
    delta: typeof delta === 'string' ? delta : '',
    usage: payload?.usage ?? null,
    toolCallDeltas,
  };
}

function mergeToolCallDeltas(target, deltas) {
  for (const delta of deltas ?? []) {
    const index = Number.isInteger(delta.index) ? delta.index : target.size;
    const current = target.get(index) ?? { id: '', name: '', arguments: '' };
    if (delta.id) current.id = delta.id;
    if (delta.name) current.name += delta.name;
    if (delta.arguments) current.arguments += delta.arguments;
    target.set(index, current);
  }
}
function normalizeToolCallDelta(value) {
  return {
    index: Number.isInteger(value?.index) ? value.index : undefined,
    id: typeof value?.id === 'string' ? value.id : '',
    name: typeof value?.function?.name === 'string' ? value.function.name : '',
    arguments: typeof value?.function?.arguments === 'string' ? value.function.arguments : '',
  };
}
function finalizeStream(text, usage, toolCalls) {
  return { text, usage, toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([index, value]) => ({ id: value.id || `tool_call_${index}`, name: value.name, arguments: value.arguments || '{}' })).filter((call) => call.name) };
}

function completionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}
function completionToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call, index) => {
    const name = typeof call?.function?.name === 'string' ? call.function.name : '';
    if (!name) return [];
    return [{ id: typeof call?.id === 'string' ? call.id : `tool_call_${index}`, name, arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}' }];
  });
}

async function safeResponseText(response) {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      return String(parsed?.error?.message ?? parsed?.message ?? raw).slice(0, 500);
    } catch {
      return raw.slice(0, 500);
    }
  } catch {
    return '';
  }
}

function abortError() {
  const error = new Error('Generation stopped');
  error.name = 'AbortError';
  return error;
}