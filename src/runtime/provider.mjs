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

  async stream(messages, { signal, onDelta }) {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({ model: this.#model, messages, stream: true }),
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
    if (!text) throw new Error('Provider returned an empty assistant response.');
    await onDelta(text);
    return { text, usage: payload?.usage ?? null };
  }
}

export async function consumeSseBody(body, onDelta, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;

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
        if (result.done) return { text, usage };
        if (result.delta) text += result.delta;
        if (result.usage) usage = result.usage;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const result = await consumeSseEvent(buffer, onDelta);
      if (result.delta) text += result.delta;
      if (result.usage) usage = result.usage;
    }
  } finally {
    reader.releaseLock();
  }

  if (!text) throw new Error('Provider stream completed without text.');
  return { text, usage };
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
  if (!data) return { done: false, delta: '' };
  if (data === '[DONE]') return { done: true, delta: '' };

  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error('Provider returned malformed streaming JSON.');
  }
  const delta = payload?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string' && delta.length > 0) {
    await onDelta(delta);
  }
  return {
    done: false,
    delta: typeof delta === 'string' ? delta : '',
    usage: payload?.usage ?? null,
  };
}

function completionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  }
  return '';
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
