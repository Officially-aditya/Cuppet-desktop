import { providerRequest } from './provider-policy.mjs';
import { fetchProvider } from './provider-fetch.mjs';
import { redactCredentials } from './credential-sanitization.mjs';

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
  #requestHeaders;
  #requestBody;

  constructor(configuration = {}) {
    const raw = record(configuration);
    const alreadyLowered = string(raw.apiKey) && string(raw.model) && ('requestHeaders' in raw || 'requestBody' in raw);
    let resolved;
    if (alreadyLowered) resolved = raw;
    else {
      try { resolved = providerRequest(configuration, 'primary'); }
      catch (error) { throw new ProviderConfigurationError(error instanceof Error ? error.message : String(error)); }
    }
    const apiKey = string(resolved.apiKey);
    const model = string(resolved.model);
    const baseUrl = string(resolved.baseUrl) || DEFAULT_BASE_URL;
    if (!apiKey) throw new ProviderConfigurationError('An API key is required. Open Provider settings and add one.');
    if (!model) throw new ProviderConfigurationError('A model is required. Open Provider settings and choose one.');
    const fetchImpl = resolved.fetchImpl ?? configuration.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '') || DEFAULT_BASE_URL;
    this.#model = model;
    this.#fetch = fetchImpl;
    this.#requestHeaders = sanitizeHeaders(resolved.requestHeaders);
    this.#requestBody = sanitizeRequestBody(resolved.requestBody);
  }

  async stream(messages, { signal, onDelta, tools = [] }) {
    const formattedMessages = formatOpenAIChatMessages(messages);
    const request = {
      ...structuredClone(this.#requestBody),
      model: this.#model,
      messages: formattedMessages,
      stream: true,
    };
    if (Array.isArray(tools) && tools.length) {
      request.tools = tools;
      request.tool_choice = 'auto';
    } else {
      delete request.tools;
      delete request.tool_choice;
    }
    const response = await fetchProvider(this.#fetch, `${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.#requestHeaders,
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      const detail = await safeResponseText(response, { apiKey: this.#apiKey });
      throw new Error(`Provider request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) return consumeSseBody(response.body, onDelta, signal, { apiKey: this.#apiKey });

    const payload = await response.json();
    const text = completionText(payload);
    const toolCalls = completionToolCalls(payload);
    if (!text && !toolCalls.length) throw new Error('Provider returned an empty assistant response.');
    if (text) await onDelta(text);
    return { text, toolCalls, usage: payload?.usage ?? null };
  }
}

export async function consumeSseBody(body, onDelta, signal, credentials = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finished = false;
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
        const result = await consumeSseEvent(event, onDelta, credentials);
        mergeToolCallDeltas(toolCalls, result.toolCallDeltas);
        if (result.done) return finalizeStream(text, usage, toolCalls);
        if (result.delta) text += result.delta;
        if (result.usage) usage = result.usage;
        finished ||= result.finished;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const result = await consumeSseEvent(buffer, onDelta, credentials);
      mergeToolCallDeltas(toolCalls, result.toolCallDeltas);
      if (result.delta) text += result.delta;
      if (result.usage) usage = result.usage;
      finished ||= result.done || result.finished;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!finished) throw new Error('Provider stream ended before completion.');
  return finalizeStream(text, usage, toolCalls);
}

export function splitSseEvents(value) {
  const normalized = value.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

async function consumeSseEvent(event, onDelta, credentials) {
  const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
  if (!data) return { done: false, delta: '', toolCallDeltas: [] };
  if (data === '[DONE]') return { done: true, delta: '', toolCallDeltas: [] };
  let payload;
  try { payload = JSON.parse(data); } catch { throw new Error('Provider returned malformed streaming JSON.'); }
  if (payload?.error || payload?.type === 'error') {
    const failure = payload.error ?? payload;
    const detail = typeof failure === 'string' ? failure : failure.message ?? failure.code ?? 'Unknown provider error';
    throw new Error(`Provider stream failed: ${redactCredentials(detail, credentials).slice(0, 500)}`);
  }
  const choice = payload?.choices?.[0] ?? {};
  const delta = choice?.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) await onDelta(delta);
  if (['length', 'content_filter'].includes(choice.finish_reason)) throw new Error(`Provider response incomplete (${choice.finish_reason}).`);
  const toolCallDeltas = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls.map(normalizeToolCallDelta) : [];
  return { done: false, finished: Boolean(choice.finish_reason), delta: typeof delta === 'string' ? delta : '', usage: payload?.usage ?? null, toolCallDeltas };
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
function normalizeToolCallDelta(value) { return { index: Number.isInteger(value?.index) ? value.index : undefined, id: typeof value?.id === 'string' ? value.id : '', name: typeof value?.function?.name === 'string' ? value.function.name : '', arguments: typeof value?.function?.arguments === 'string' ? value.function.arguments : '' }; }
function finalizeStream(text, usage, toolCalls) {
  const result = { text, usage, toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([index, value]) => ({ id: value.id || `tool_call_${index}`, name: value.name, arguments: value.arguments || '{}' })).filter((call) => call.name) };
  if (!result.text && !result.toolCalls.length) throw new Error('Provider stream completed without text or tool calls.');
  return result;
}
function completionText(payload) { const content = payload?.choices?.[0]?.message?.content; if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join(''); return ''; }
function completionToolCalls(payload) { const calls = payload?.choices?.[0]?.message?.tool_calls; if (!Array.isArray(calls)) return []; return calls.flatMap((call, index) => { const name = typeof call?.function?.name === 'string' ? call.function.name : ''; if (!name) return []; return [{ id: typeof call?.id === 'string' ? call.id : `tool_call_${index}`, name, arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}' }]; }); }
async function safeResponseText(response, credentials) { try { const raw = (await response.text()).trim(); if (!raw) return ''; try { const parsed = JSON.parse(raw); return redactCredentials(parsed?.error?.message ?? parsed?.message ?? raw, credentials).slice(0, 500); } catch { return redactCredentials(raw, credentials).slice(0, 500); } } catch { return ''; } }
function sanitizeHeaders(value) { const source = record(value); return Object.fromEntries(Object.entries(source).flatMap(([key, item]) => typeof item === 'string' && !['authorization','proxy-authorization','cookie','set-cookie'].includes(key.toLowerCase()) ? [[key, item.slice(0, 4000)]] : [])); }
function sanitizeRequestBody(value) { return structuredClone(record(value)); }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function string(value) { return typeof value === 'string' ? value.trim() : ''; }

export function formatOpenAIChatMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role === 'user' && Array.isArray(message.imageAttachments) && message.imageAttachments.length) {
      const parts = [{ type: 'text', text: String(message.content ?? '') }];
      for (const img of message.imageAttachments) {
        if (typeof img?.dataUrl === 'string' && img.dataUrl) {
          parts.push({
            type: 'image_url',
            image_url: { url: img.dataUrl },
          });
        }
      }
      return { role: 'user', content: parts };
    }
    return { role: message.role, content: message.content };
  });
}

