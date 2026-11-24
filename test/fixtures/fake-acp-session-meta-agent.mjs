import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    const meta = message.params?._meta;
    if (meta && Object.keys(meta).length) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Cuppet overrode Claude session metadata' } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'meta-session', configOptions: [] } });
    return;
  }
  if (message.method === 'session/prompt') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'meta-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
