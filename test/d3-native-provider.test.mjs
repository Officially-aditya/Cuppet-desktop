import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleChatProvider } from '../src/runtime/provider.mjs';
import { createChatProvider, nativeProviderKind } from '../src/runtime/provider-factory.mjs';
import {
  AnthropicMessagesProvider,
  GeminiInteractionsProvider,
  OpenAIResponsesProvider,
  VertexGeminiProvider,
} from '../src/runtime/native-provider.mjs';

const TOOL = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Look something up',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

function lowered(providerID, fetchImpl, model = 'test-model') {
  return {
    providerID,
    apiKey: 'host-secret',
    baseUrl: 'https://api.openai.com/v1',
    model,
    modelID: model,
    requestHeaders: { authorization: 'must-drop', cookie: 'must-drop', 'x-safe': 'yes' },
    requestBody: {},
    fetchImpl,
  };
}

function sse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('provider factory selects only reviewed native transports and preserves generic fallback', () => {
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  assert.ok(createChatProvider(lowered('openai', fetchImpl)) instanceof OpenAIResponsesProvider);
  assert.ok(createChatProvider(lowered('anthropic', fetchImpl)) instanceof AnthropicMessagesProvider);
  assert.ok(createChatProvider(lowered('google', fetchImpl)) instanceof GeminiInteractionsProvider);
  assert.ok(createChatProvider(lowered('google-vertex', fetchImpl)) instanceof VertexGeminiProvider);
  assert.ok(createChatProvider(lowered('openai-compatible', fetchImpl)) instanceof OpenAICompatibleChatProvider);
  assert.ok(createChatProvider(lowered('future-provider', fetchImpl)) instanceof OpenAICompatibleChatProvider);
  assert.equal(nativeProviderKind('google-vertex-anthropic'), null);
  assert.equal(nativeProviderKind('azure'), null);
});

test('OpenAI native adapter uses Responses streaming and normalizes function calls', async () => {
  let request;
  const controller = new AbortController();
  const provider = createChatProvider(lowered('openai', async (url, init) => {
    request = { url, init };
    return sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"value":' },
      { type: 'response.output_text.delta', delta: 'Checking…' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"alpha"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 7 } } },
    ]);
  }));
  const deltas = [];
  const result = await provider.stream([{ role: 'user', content: 'check alpha' }], { signal: controller.signal, onDelta: async (delta) => deltas.push(delta), tools: [TOOL] });

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.signal, controller.signal);
  assert.equal(request.init.headers.authorization, 'Bearer host-secret');
  assert.equal(request.init.headers.cookie, undefined);
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools[0], { type: 'function', name: 'lookup', description: 'Look something up', parameters: TOOL.function.parameters });
  assert.deepEqual(deltas, ['Checking…']);
  assert.equal(result.text, 'Checking…');
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'lookup', arguments: '{"value":"alpha"}' }]);
  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7 });
});

test('Anthropic native adapter translates system, tool use, tool result, and streamed JSON arguments', async () => {
  let request;
  const provider = createChatProvider(lowered('anthropic', async (url, init) => {
    request = { url, init };
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Next ' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_2', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"value":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"beta"}' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
  }));
  const messages = [
    { role: 'system', content: 'System policy' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'lookup', arguments: '{"value":"alpha"}' } }] },
    { role: 'tool', tool_call_id: 'tool_1', name: 'lookup', content: 'alpha-result' },
  ];
  const deltas = [];
  const result = await provider.stream(messages, { onDelta: async (delta) => deltas.push(delta), tools: [TOOL] });

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.init.headers['x-api-key'], 'host-secret');
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.init.headers.authorization, undefined);
  const body = JSON.parse(request.init.body);
  assert.equal(body.system, 'System policy');
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.equal(body.messages[1].content[0].type, 'tool_use');
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.deepEqual(deltas, ['Next ']);
  assert.deepEqual(result.toolCalls, [{ id: 'tool_2', name: 'lookup', arguments: '{"value":"beta"}' }]);
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 5 });
});

test('Gemini Interactions keeps tool continuation state and lowers function_result using current REST shape', async () => {
  const requests = [];
  const responses = [
    sse([
      { event_type: 'interaction.created', interaction: { id: 'interaction_1' } },
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'call_1', name: 'lookup' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"value":"gamma"}' } },
      { event_type: 'interaction.requires_action', interaction: { id: 'interaction_1', usage: { total_tokens: 20 } } },
      '[DONE]',
    ]),
    sse([
      { event_type: 'interaction.created', interaction: { id: 'interaction_2' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Resolved gamma.' } },
      { event_type: 'interaction.completed', interaction: { id: 'interaction_2', usage: { total_tokens: 9 } } },
      '[DONE]',
    ]),
  ];
  const provider = createChatProvider(lowered('google', async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return responses.shift();
  }, 'gemini-test'));

  const first = await provider.stream([
    { role: 'system', content: 'System policy' },
    { role: 'user', content: 'lookup gamma' },
  ], { onDelta: async () => {}, tools: [TOOL] });
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'lookup', arguments: '{"value":"gamma"}' }]);

  const deltas = [];
  const second = await provider.stream([
    { role: 'system', content: 'System policy' },
    { role: 'user', content: 'lookup gamma' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"value":"gamma"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'gamma-result' },
  ], { onDelta: async (delta) => deltas.push(delta), tools: [TOOL] });

  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(requests[0].init.headers['x-goog-api-key'], 'host-secret');
  assert.equal(requests[0].body.system_instruction, 'System policy');
  assert.equal(requests[0].body.tools[0].name, 'lookup');
  assert.equal(requests[1].body.previous_interaction_id, 'interaction_1');
  assert.equal(requests[1].body.tools[0].name, 'lookup');
  assert.equal(requests[1].body.input[0].type, 'function_result');
  assert.equal(requests[1].body.input[0].call_id, 'call_1');
  assert.deepEqual(requests[1].body.input[0].result, { content: [{ type: 'text', text: 'gamma-result' }] });
  assert.deepEqual(deltas, ['Resolved gamma.']);
  assert.equal(second.text, 'Resolved gamma.');
});

test('Vertex native adapter keeps model function-call history, returns functionResponse, and never puts API key in URL', async () => {
  const requests = [];
  const responses = [
    sse([
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'vertex_call_1', name: 'lookup', args: { value: 'delta' } } }] } }], usageMetadata: { promptTokenCount: 8 } },
    ]),
    sse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Resolved delta.' }] } }], usageMetadata: { candidatesTokenCount: 4 } },
    ]),
  ];
  const provider = createChatProvider(lowered('google-vertex', async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return responses.shift();
  }, 'gemini-test'));

  const first = await provider.stream([{ role: 'user', content: 'lookup delta' }], { onDelta: async () => {}, tools: [TOOL] });
  assert.deepEqual(first.toolCalls, [{ id: 'vertex_call_1', name: 'lookup', arguments: '{"value":"delta"}' }]);

  const deltas = [];
  const second = await provider.stream([
    { role: 'user', content: 'lookup delta' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'vertex_call_1', type: 'function', function: { name: 'lookup', arguments: '{"value":"delta"}' } }] },
    { role: 'tool', tool_call_id: 'vertex_call_1', name: 'lookup', content: 'delta-result' },
  ], { onDelta: async (delta) => deltas.push(delta), tools: [TOOL] });

  assert.match(requests[0].url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-test:streamGenerateContent\?alt=sse$/);
  assert.doesNotMatch(requests[0].url, /host-secret|[?&]key=/);
  assert.equal(requests[0].init.headers['x-goog-api-key'], 'host-secret');
  assert.equal(requests[0].body.tools[0].functionDeclarations[0].name, 'lookup');
  assert.equal(requests[1].body.contents[1].role, 'model');
  assert.equal(requests[1].body.contents[1].parts[0].functionCall.id, 'vertex_call_1');
  assert.equal(requests[1].body.contents[2].parts[0].functionResponse.id, 'vertex_call_1');
  assert.deepEqual(deltas, ['Resolved delta.']);
  assert.equal(second.text, 'Resolved delta.');
});

test('unknown providers still execute through the OpenAI-compatible chat fallback', async () => {
  let url;
  const provider = createChatProvider({
    ...lowered('future-provider', async (value) => {
      url = value;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
    baseUrl: 'https://future.example/v1',
  });
  const deltas = [];
  const result = await provider.stream([{ role: 'user', content: 'hello' }], { onDelta: async (delta) => deltas.push(delta) });
  assert.equal(url, 'https://future.example/v1/chat/completions');
  assert.equal(result.text, 'fallback-ok');
  assert.deepEqual(deltas, ['fallback-ok']);
});
