import { providerRequest } from './provider-policy.mjs';

const ANTHROPIC_VERSION = '2023-06-01';

export class OpenAIResponsesProvider {
  #config; #fetch;
  constructor(configuration = {}) {
    this.#config = resolved(configuration);
    this.#fetch = fetcher(configuration);
  }

  async stream(messages, { signal, onDelta = async () => {}, tools = [] } = {}) {
    const request = {
      ...structuredClone(this.#config.requestBody),
      model: this.#config.model,
      input: openAIInput(messages),
      stream: true,
      store: false,
    };
    const translatedTools = responseTools(tools);
    if (translatedTools.length) {
      request.tools = translatedTools;
      request.tool_choice = 'auto';
    } else {
      delete request.tools;
      delete request.tool_choice;
    }
    const response = await this.#fetch(`${this.#config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        ...this.#config.requestHeaders,
        authorization: `Bearer ${this.#config.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
    await assertOk(response);
    if (isSse(response) && response.body) return consumeOpenAIResponsesSse(response.body, onDelta, signal);
    const payload = await response.json();
    const result = openAIResponseResult(payload);
    if (!result.text && !result.toolCalls.length) throw new Error('OpenAI returned an empty response.');
    if (result.text) await onDelta(result.text);
    return result;
  }
}

export class AnthropicMessagesProvider {
  #config; #fetch;
  constructor(configuration = {}) {
    this.#config = resolved(configuration);
    this.#fetch = fetcher(configuration);
  }

  async stream(messages, { signal, onDelta = async () => {}, tools = [] } = {}) {
    const translated = anthropicConversation(messages);
    const request = {
      ...structuredClone(this.#config.requestBody),
      model: this.#config.model,
      messages: translated.messages,
      max_tokens: positiveInt(this.#config.requestBody?.max_tokens, this.#config.outputLimit || 16_384),
      stream: true,
    };
    if (translated.system) request.system = translated.system;
    else delete request.system;
    const translatedTools = anthropicTools(tools);
    if (translatedTools.length) request.tools = translatedTools;
    else delete request.tools;

    const response = await this.#fetch(`${this.#config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        ...this.#config.requestHeaders,
        'x-api-key': this.#config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
    await assertOk(response);
    if (isSse(response) && response.body) return consumeAnthropicSse(response.body, onDelta, signal);
    const payload = await response.json();
    const result = anthropicResult(payload);
    if (!result.text && !result.toolCalls.length) throw new Error('Anthropic returned an empty response.');
    if (result.text) await onDelta(result.text);
    return result;
  }
}

export class GeminiInteractionsProvider {
  #config; #fetch; #previousInteractionId = null; #sentToolResults = new Set(); #systemInstruction = '';
  constructor(configuration = {}) {
    this.#config = resolved(configuration);
    this.#fetch = fetcher(configuration);
  }

  async stream(messages, { signal, onDelta = async () => {}, tools = [] } = {}) {
    const initial = !this.#previousInteractionId;
    if (initial) this.#systemInstruction = systemText(messages);
    const input = initial ? geminiInitialInput(messages) : geminiToolResults(messages, this.#sentToolResults);
    if (!input.length) throw new Error('Gemini continuation requires at least one new tool result.');
    const submittedToolResultIds = input.flatMap((item) => item?.type === 'function_result' && item.call_id ? [String(item.call_id)] : []);

    const request = {
      ...geminiGenerationConfig(this.#config.requestBody),
      model: stripModelPrefix(this.#config.model),
      input,
      stream: true,
    };
    if (this.#systemInstruction) request.system_instruction = this.#systemInstruction;
    if (this.#previousInteractionId) request.previous_interaction_id = this.#previousInteractionId;
    const translatedTools = interactionTools(tools);
    if (translatedTools.length) request.tools = translatedTools;

    const response = await this.#fetch(`${this.#config.baseUrl}/interactions`, {
      method: 'POST',
      headers: {
        ...this.#config.requestHeaders,
        'x-goog-api-key': this.#config.apiKey,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
    await assertOk(response);
    let result;
    if (isSse(response) && response.body) result = await consumeGeminiInteractionSse(response.body, onDelta, signal);
    else {
      const payload = await response.json();
      result = geminiInteractionResult(payload);
      if (result.text) await onDelta(result.text);
    }
    if (result.interactionId) this.#previousInteractionId = result.interactionId;
    for (const id of submittedToolResultIds) this.#sentToolResults.add(id);
    if (!result.text && !result.toolCalls.length) throw new Error('Gemini returned an empty interaction.');
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage ?? null };
  }
}

export class VertexGeminiProvider {
  #config; #fetch; #history = null; #sentToolResults = new Set();
  constructor(configuration = {}) {
    this.#config = resolved(configuration);
    this.#fetch = fetcher(configuration);
  }

  async stream(messages, { signal, onDelta = async () => {}, tools = [] } = {}) {
    if (!this.#history) this.#history = vertexInitialContents(messages);
    const newResults = vertexToolResultContent(messages, this.#sentToolResults);
    if (newResults) this.#history.push(newResults);

    const request = {
      ...vertexRequestBody(this.#config.requestBody),
      contents: structuredClone(this.#history),
    };
    const system = systemText(messages);
    if (system) request.systemInstruction = { parts: [{ text: system }] };
    const translatedTools = vertexTools(tools);
    if (translatedTools.length) request.tools = translatedTools;

    const modelResource = vertexModelResource(this.#config.model);
    const separator = this.#config.baseUrl.includes('?') ? '&' : '?';
    const url = `${this.#config.baseUrl}/${modelResource}:streamGenerateContent${separator}alt=sse&key=${encodeURIComponent(this.#config.apiKey)}`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        ...this.#config.requestHeaders,
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
    await assertOk(response);
    let result;
    if (isSse(response) && response.body) result = await consumeVertexSse(response.body, onDelta, signal);
    else {
      const payload = await response.json();
      result = vertexChunkResult(payload);
      if (result.text) await onDelta(result.text);
    }
    if (result.modelContent) this.#history.push(result.modelContent);
    if (!result.text && !result.toolCalls.length) throw new Error('Vertex Gemini returned an empty response.');
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage ?? null };
  }
}

export function createNativeProvider(configuration = {}) {
  const config = resolved(configuration);
  const prepared = { ...config, ...(configuration?.fetchImpl ? { fetchImpl: configuration.fetchImpl } : {}) };
  switch (config.providerID.toLowerCase()) {
    case 'openai': return new OpenAIResponsesProvider(prepared);
    case 'anthropic': return new AnthropicMessagesProvider(prepared);
    case 'google': return new GeminiInteractionsProvider(prepared);
    case 'google-vertex': return new VertexGeminiProvider(prepared);
    default: return null;
  }
}

export function nativeProviderKind(providerID) {
  switch (String(providerID ?? '').trim().toLowerCase()) {
    case 'openai': return 'openai-responses';
    case 'anthropic': return 'anthropic-messages';
    case 'google': return 'gemini-interactions';
    case 'google-vertex': return 'vertex-gemini';
    default: return null;
  }
}

export async function consumeOpenAIResponsesSse(body, onDelta = async () => {}, signal) {
  let text = '';
  let usage = null;
  const calls = new Map();
  for await (const payload of ssePayloads(body, signal)) {
    const type = payload?.type;
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      text += payload.delta;
      await onDelta(payload.delta);
    } else if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
      const key = payload.item.id || `output_${payload.output_index ?? calls.size}`;
      calls.set(key, {
        id: payload.item.call_id || payload.item.id || key,
        name: string(payload.item.name),
        arguments: string(payload.item.arguments),
      });
    } else if (type === 'response.function_call_arguments.delta') {
      const key = payload.item_id || `output_${payload.output_index ?? calls.size}`;
      const call = calls.get(key) ?? { id: key, name: '', arguments: '' };
      call.arguments += typeof payload.delta === 'string' ? payload.delta : '';
      calls.set(key, call);
    } else if (type === 'response.function_call_arguments.done') {
      const key = payload.item_id || `output_${payload.output_index ?? calls.size}`;
      const call = calls.get(key) ?? { id: key, name: '', arguments: '' };
      if (typeof payload.arguments === 'string') call.arguments = payload.arguments;
      calls.set(key, call);
    } else if (type === 'response.output_item.done' && payload.item?.type === 'function_call') {
      const key = payload.item.id || `output_${payload.output_index ?? calls.size}`;
      const call = calls.get(key) ?? { id: key, name: '', arguments: '' };
      call.id = payload.item.call_id || call.id;
      call.name = string(payload.item.name) || call.name;
      if (typeof payload.item.arguments === 'string') call.arguments = payload.item.arguments;
      calls.set(key, call);
    } else if (type === 'response.completed') {
      usage = payload.response?.usage ?? usage;
      mergeOpenAIFinalCalls(calls, payload.response);
    } else if (type === 'response.failed') {
      throw new Error(providerFailure(payload.response?.error ?? payload.error, 'OpenAI response failed'));
    } else if (type === 'error') {
      throw new Error(providerFailure(payload.error ?? payload, 'OpenAI stream failed'));
    }
  }
  return { text, toolCalls: callsToArray(calls), usage };
}

export async function consumeAnthropicSse(body, onDelta = async () => {}, signal) {
  let text = '';
  let usage = null;
  const blocks = new Map();
  for await (const payload of ssePayloads(body, signal)) {
    const type = payload?.type;
    if (type === 'message_start') usage = payload.message?.usage ?? usage;
    else if (type === 'content_block_start') {
      const block = payload.content_block ?? {};
      if (block.type === 'tool_use') blocks.set(payload.index, {
        id: string(block.id) || `tool_${payload.index}`,
        name: string(block.name),
        arguments: objectJson(block.input, ''),
      });
      else blocks.set(payload.index, { type: block.type });
    } else if (type === 'content_block_delta') {
      const delta = payload.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        await onDelta(delta.text);
      } else if (delta.type === 'input_json_delta') {
        const block = blocks.get(payload.index) ?? { id: `tool_${payload.index}`, name: '', arguments: '' };
        block.arguments = `${block.arguments ?? ''}${typeof delta.partial_json === 'string' ? delta.partial_json : ''}`;
        blocks.set(payload.index, block);
      }
    } else if (type === 'message_delta') {
      usage = { ...(usage ?? {}), ...(payload.usage ?? {}) };
    } else if (type === 'error') {
      throw new Error(providerFailure(payload.error, 'Anthropic stream failed'));
    }
  }
  const toolCalls = [...blocks.entries()]
    .filter(([, block]) => block?.name)
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => ({ id: block.id || `tool_${index}`, name: block.name, arguments: block.arguments || '{}' }));
  return { text, toolCalls, usage };
}

export async function consumeGeminiInteractionSse(body, onDelta = async () => {}, signal) {
  let text = '';
  let usage = null;
  let interactionId = null;
  const calls = new Map();
  const consumedToolResultIds = [];
  for await (const payload of ssePayloads(body, signal)) {
    const type = payload?.event_type ?? payload?.type;
    if (type === 'interaction.created') interactionId = payload.interaction?.id ?? payload.interaction_id ?? interactionId;
    else if (type === 'step.start') {
      const step = payload.step ?? {};
      if (step.type === 'function_call') calls.set(payload.index, {
        id: string(step.id) || `function_${payload.index}`,
        name: string(step.name),
        arguments: objectJson(step.arguments, ''),
      });
      if (step.type === 'function_result' && step.call_id) consumedToolResultIds.push(String(step.call_id));
    } else if (type === 'step.delta') {
      const delta = payload.delta ?? {};
      if (delta.type === 'text' && typeof delta.text === 'string') {
        text += delta.text;
        await onDelta(delta.text);
      }
      if (delta.type === 'arguments_delta' || typeof delta.arguments_delta === 'string' || typeof delta.arguments === 'string') {
        const call = calls.get(payload.index) ?? { id: `function_${payload.index}`, name: '', arguments: '' };
        call.arguments += string(delta.arguments_delta) || string(delta.arguments);
        calls.set(payload.index, call);
      }
    } else if (type === 'interaction.completed' || type === 'interaction.requires_action') {
      const interaction = payload.interaction ?? {};
      interactionId = interaction.id ?? payload.interaction_id ?? interactionId;
      usage = interaction.usage ?? usage;
      mergeGeminiSteps(calls, interaction.steps);
    } else if (type === 'interaction.failed') {
      throw new Error(providerFailure(payload.interaction?.errors?.[0] ?? payload.error, 'Gemini interaction failed'));
    } else if (type === 'error') {
      throw new Error(providerFailure(payload.error ?? payload, 'Gemini stream failed'));
    }
  }
  return { text, toolCalls: callsToArray(calls), usage, interactionId, consumedToolResultIds };
}

export async function consumeVertexSse(body, onDelta = async () => {}, signal) {
  let text = '';
  let usage = null;
  const calls = new Map();
  const modelParts = [];
  for await (const payload of ssePayloads(body, signal)) {
    const chunk = vertexChunkResult(payload);
    if (chunk.text) {
      text += chunk.text;
      await onDelta(chunk.text);
    }
    usage = chunk.usage ?? usage;
    for (const call of chunk.toolCalls) {
      const key = call.id || `${call.name}:${calls.size}`;
      calls.set(key, call);
    }
    for (const part of chunk.modelContent?.parts ?? []) {
      if (part.text) {
        const last = modelParts.at(-1);
        if (last?.text !== undefined) last.text += part.text;
        else modelParts.push({ text: part.text });
      } else modelParts.push(structuredClone(part));
    }
  }
  return {
    text,
    toolCalls: [...calls.values()],
    usage,
    modelContent: modelParts.length ? { role: 'model', parts: modelParts } : null,
  };
}

function resolved(configuration) {
  const raw = record(configuration);
  if (string(raw.apiKey) && string(raw.model) && string(raw.providerID) && ('requestHeaders' in raw || 'requestBody' in raw)) {
    return {
      providerID: string(raw.providerID),
      baseUrl: nativeBaseUrl(string(raw.providerID), string(raw.baseUrl)),
      apiKey: string(raw.apiKey),
      model: string(raw.model),
      modelID: string(raw.modelID) || string(raw.model),
      outputLimit: positiveInt(raw.outputLimit, 16_384),
      requestHeaders: safeHeaders(raw.requestHeaders),
      requestBody: structuredClone(record(raw.requestBody)),
    };
  }
  const request = providerRequest(configuration, 'primary');
  return { ...request, baseUrl: nativeBaseUrl(request.providerID, request.baseUrl) };
}

function fetcher(configuration) {
  const value = configuration?.fetchImpl ?? globalThis.fetch;
  if (typeof value !== 'function') throw new Error('fetch is unavailable');
  return value;
}

function openAIInput(messages) {
  const output = [];
  for (const message of array(messages)) {
    if (message?.role === 'tool') {
      if (message.tool_call_id) output.push({ type: 'function_call_output', call_id: String(message.tool_call_id), output: String(message.content ?? '') });
      continue;
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) output.push({ role: 'assistant', content: String(message.content) });
      for (const call of message.tool_calls) {
        if (call?.function?.name) output.push({
          type: 'function_call',
          call_id: String(call.id || ''),
          name: String(call.function.name),
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
        });
      }
      continue;
    }
    if (['system', 'developer', 'user', 'assistant'].includes(message?.role) && message.content != null) {
      output.push({ role: message.role, content: String(message.content) });
    }
  }
  return output;
}

function responseTools(tools) {
  return array(tools).flatMap((tool) => {
    const fn = tool?.function;
    if (!fn?.name) return [];
    return [{
      type: 'function',
      name: String(fn.name),
      description: String(fn.description ?? ''),
      parameters: structuredClone(record(fn.parameters)),
    }];
  });
}

function openAIResponseResult(payload) {
  let text = typeof payload?.output_text === 'string' ? payload.output_text : '';
  const toolCalls = [];
  for (const item of array(payload?.output)) {
    if (item?.type === 'message') {
      for (const part of array(item.content)) if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    } else if (item?.type === 'function_call' && item.name) {
      toolCalls.push({ id: item.call_id || item.id || `tool_${toolCalls.length}`, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' });
    }
  }
  return { text, toolCalls, usage: payload?.usage ?? null };
}

function mergeOpenAIFinalCalls(calls, response) {
  for (const item of array(response?.output)) {
    if (item?.type !== 'function_call' || !item.name) continue;
    const key = item.id || `final_${calls.size}`;
    calls.set(key, { id: item.call_id || item.id || key, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' });
  }
}

function anthropicConversation(messages) {
  const system = [];
  const output = [];
  for (const message of array(messages)) {
    if (message?.role === 'system' || message?.role === 'developer') {
      if (message.content) system.push(String(message.content));
      continue;
    }
    if (message?.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: String(message.content ?? '') };
      const last = output.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((part) => part?.type === 'tool_result')) last.content.push(block);
      else output.push({ role: 'user', content: [block] });
      continue;
    }
    if (message?.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const call of array(message.tool_calls)) {
        if (!call?.function?.name) continue;
        content.push({
          type: 'tool_use',
          id: String(call.id || ''),
          name: String(call.function.name),
          input: parseObject(call.function.arguments),
        });
      }
      if (content.length) output.push({ role: 'assistant', content });
      continue;
    }
    if (message?.role === 'user' && message.content != null) output.push({ role: 'user', content: String(message.content) });
  }
  return { system: system.join('\n\n'), messages: output };
}

function anthropicTools(tools) {
  return array(tools).flatMap((tool) => {
    const fn = tool?.function;
    if (!fn?.name) return [];
    return [{ name: String(fn.name), description: String(fn.description ?? ''), input_schema: structuredClone(record(fn.parameters)) }];
  });
}

function anthropicResult(payload) {
  let text = '';
  const toolCalls = [];
  for (const block of array(payload?.content)) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'tool_use' && block.name) toolCalls.push({
      id: block.id || `tool_${toolCalls.length}`,
      name: block.name,
      arguments: JSON.stringify(record(block.input)),
    });
  }
  return { text, toolCalls, usage: payload?.usage ?? null };
}

function systemText(messages) {
  return array(messages).flatMap((message) => ['system', 'developer'].includes(message?.role) && message.content ? [String(message.content)] : []).join('\n\n');
}

function geminiInitialInput(messages) {
  const output = [];
  for (const message of array(messages)) {
    if (message?.role === 'system' || message?.role === 'developer' || message?.role === 'tool') continue;
    if (message?.role === 'user' && message.content != null) output.push({ type: 'user_input', content: [{ type: 'text', text: String(message.content) }] });
    else if (message?.role === 'assistant' && message.content) output.push({ type: 'model_output', content: [{ type: 'text', text: String(message.content) }] });
  }
  return output;
}

function geminiToolResults(messages, sent) {
  return array(messages).flatMap((message) => {
    if (message?.role !== 'tool' || !message.tool_call_id || sent.has(String(message.tool_call_id))) return [];
    return [{
      type: 'function_result',
      name: String(message.name || ''),
      call_id: String(message.tool_call_id),
      result: [{ type: 'text', text: String(message.content ?? '') }],
    }];
  });
}

function interactionTools(tools) {
  return array(tools).flatMap((tool) => {
    const fn = tool?.function;
    if (!fn?.name) return [];
    return [{ type: 'function', name: String(fn.name), description: String(fn.description ?? ''), parameters: structuredClone(record(fn.parameters)) }];
  });
}

function geminiGenerationConfig(body) {
  const source = structuredClone(record(body));
  const output = {};
  if (source.generation_config && typeof source.generation_config === 'object') output.generation_config = source.generation_config;
  else if (source.generationConfig && typeof source.generationConfig === 'object') output.generation_config = source.generationConfig;
  for (const key of ['response_format', 'service_tier', 'safety_settings']) if (source[key] !== undefined) output[key] = source[key];
  return output;
}

function geminiInteractionResult(payload) {
  let text = '';
  const calls = new Map();
  for (const step of array(payload?.steps)) {
    if (step?.type === 'model_output') for (const part of array(step.content)) if (part?.type === 'text' && typeof part.text === 'string') text += part.text;
    if (step?.type === 'function_call' && step.name) calls.set(step.id || `function_${calls.size}`, {
      id: step.id || `function_${calls.size}`,
      name: step.name,
      arguments: JSON.stringify(record(step.arguments)),
    });
  }
  return { text, toolCalls: [...calls.values()], usage: payload?.usage ?? null, interactionId: payload?.id ?? null, consumedToolResultIds: [] };
}

function mergeGeminiSteps(calls, steps) {
  for (const step of array(steps)) {
    if (step?.type !== 'function_call' || !step.name) continue;
    const key = step.id || `function_${calls.size}`;
    calls.set(key, { id: step.id || key, name: step.name, arguments: JSON.stringify(record(step.arguments)) });
  }
}

function vertexInitialContents(messages) {
  return array(messages).flatMap((message) => {
    if (message?.role === 'system' || message?.role === 'developer' || message?.role === 'tool') return [];
    if (message?.role === 'user' && message.content != null) return [{ role: 'user', parts: [{ text: String(message.content) }] }];
    if (message?.role === 'assistant' && message.content) return [{ role: 'model', parts: [{ text: String(message.content) }] }];
    return [];
  });
}

function vertexToolResultContent(messages, sent) {
  const parts = [];
  for (const message of array(messages)) {
    if (message?.role !== 'tool' || !message.tool_call_id || sent.has(String(message.tool_call_id))) continue;
    sent.add(String(message.tool_call_id));
    parts.push({
      functionResponse: {
        id: String(message.tool_call_id),
        name: String(message.name || ''),
        response: { output: String(message.content ?? '') },
      },
    });
  }
  return parts.length ? { role: 'user', parts } : null;
}

function vertexTools(tools) {
  const functionDeclarations = array(tools).flatMap((tool) => {
    const fn = tool?.function;
    if (!fn?.name) return [];
    return [{ name: String(fn.name), description: String(fn.description ?? ''), parameters: structuredClone(record(fn.parameters)) }];
  });
  return functionDeclarations.length ? [{ functionDeclarations }] : [];
}

function vertexRequestBody(body) {
  const source = structuredClone(record(body));
  const output = {};
  if (source.generationConfig && typeof source.generationConfig === 'object') output.generationConfig = source.generationConfig;
  else if (source.generation_config && typeof source.generation_config === 'object') output.generationConfig = source.generation_config;
  if (Array.isArray(source.safetySettings)) output.safetySettings = source.safetySettings;
  return output;
}

function vertexModelResource(model) {
  const value = stripLeadingSlash(String(model));
  if (value.includes('/')) return value;
  return `publishers/google/models/${value}`;
}

function vertexChunkResult(payload) {
  let text = '';
  const toolCalls = [];
  const parts = [];
  const content = payload?.candidates?.[0]?.content;
  for (const part of array(content?.parts)) {
    if (typeof part?.text === 'string') {
      text += part.text;
      parts.push(structuredClone(part));
    } else if (part?.functionCall?.name) {
      const call = part.functionCall;
      toolCalls.push({
        id: call.id || `function_${toolCalls.length}`,
        name: call.name,
        arguments: JSON.stringify(record(call.args)),
      });
      parts.push(structuredClone(part));
    } else if (part && typeof part === 'object') parts.push(structuredClone(part));
  }
  return {
    text,
    toolCalls,
    usage: payload?.usageMetadata ?? null,
    modelContent: parts.length ? { role: content?.role || 'model', parts } : null,
  };
}

async function* ssePayloads(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitEvents(buffer);
      buffer = split.rest;
      for (const event of split.events) {
        const payload = eventPayload(event);
        if (payload === null) continue;
        if (payload === '[DONE]') return;
        yield payload;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = eventPayload(buffer);
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function splitEvents(value) {
  const normalized = String(value).replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

function eventPayload(event) {
  const data = String(event).split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) return null;
  if (data === '[DONE]') return '[DONE]';
  try { return JSON.parse(data); }
  catch { throw new Error('Provider returned malformed streaming JSON.'); }
}

function callsToArray(calls) {
  return [...calls.entries()].map(([key, call]) => ({
    id: call.id || key,
    name: call.name,
    arguments: call.arguments || '{}',
  })).filter((call) => call.name);
}

function objectJson(value, fallback = '{}') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return fallback;
  return JSON.stringify(value);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function assertOk(response) {
  if (response?.ok) return;
  const status = Number(response?.status) || 0;
  let detail = '';
  try {
    const raw = (await response.text()).trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        detail = providerFailure(parsed?.error ?? parsed, '');
      } catch {
        detail = raw.slice(0, 500);
      }
    }
  } catch {}
  throw new Error(`Provider request failed (${status})${detail ? `: ${detail}` : ''}`);
}

function providerFailure(value, fallback) {
  if (typeof value === 'string') return value.slice(0, 500);
  const source = record(value);
  return String(source.message ?? source.detail ?? source.code ?? fallback).slice(0, 500);
}

function isSse(response) {
  return String(response?.headers?.get?.('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

function safeHeaders(value) {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) =>
    typeof item === 'string' && !['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-goog-api-key'].includes(key.toLowerCase())
      ? [[key, item.slice(0, 4000)]]
      : []));
}

function nativeBaseUrl(providerID, value) {
  const provider = String(providerID ?? '').trim().toLowerCase();
  const current = stripSlash(String(value ?? '').trim());
  const inheritedOpenAI = !current || current === 'https://api.openai.com/v1';
  if (!inheritedOpenAI) return current;
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
  if (provider === 'google') return 'https://generativelanguage.googleapis.com/v1beta';
  if (provider === 'google-vertex') return 'https://aiplatform.googleapis.com/v1';
  return current || 'https://api.openai.com/v1';
}

function stripModelPrefix(value) {
  return String(value ?? '').replace(/^models\//, '');
}

function stripLeadingSlash(value) {
  return value.replace(/^\/+/, '');
}

function stripSlash(value) {
  return value.replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
