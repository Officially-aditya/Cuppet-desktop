import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let authenticated = null;

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: 'test.api_key' }, { id: 'cached_token' }],
      },
    });
    return;
  }
  if (message.method === 'authenticate') {
    authenticated = message.params?.methodId ?? null;
    write({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/new') {
    if (!authenticated) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'authenticate first' } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'auth-session', configOptions: [] } });
    return;
  }
  if (message.method === 'session/prompt') {
    write({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'auth-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: authenticated } } },
    });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
