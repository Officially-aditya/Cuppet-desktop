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
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'heartbeat-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'heartbeat-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `tick-${count}` } } } });
      if (count === 5) {
        clearInterval(timer);
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'heartbeat-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Alive.' } } } });
        write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }, 20);
  }
});
