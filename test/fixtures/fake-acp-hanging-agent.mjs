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
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'hang-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'hang-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Started' } } } });
  }
});
