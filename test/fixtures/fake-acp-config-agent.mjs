import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let model = 'provider/model-a';
let effort = 'low';
let sessionNewAttempts = 0;

function effortValues() {
  return model === 'provider/model-b' ? ['medium', 'max'] : ['low', 'high'];
}
function options() {
  const values = effortValues();
  if (!values.includes(effort)) effort = values[0];
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
      { value: 'provider/model-a', name: 'Model A' }, { value: 'provider/model-b', name: 'Model B' },
    ] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: values.map((value) => ({ value, name: value })) },
  ];
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    sessionNewAttempts += 1;
    if (process.env.FAKE_ACP_SESSION_NEW_INTERNAL_ONCE === '1' && sessionNewAttempts === 1) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error', data: { service: 'directory' } } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'config-session', configOptions: options() } });
    return;
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') model = message.params.value;
    if (message.params.configId === 'effort') effort = message.params.value;
    write({ jsonrpc: '2.0', id: message.id, result: { configOptions: options() } });
    return;
  }
  if (message.method === 'session/prompt') {
    if (model !== 'provider/model-b' || effort !== 'max') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `wrong config ${model}/${effort}` } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting project.' } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', status: 'pending', kind: 'search', title: 'Search files', rawInput: { query: 'TODO' } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', kind: 'search', title: 'Search files', rawInput: { query: 'TODO' }, rawOutput: { matches: 2 } } } });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'config-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
