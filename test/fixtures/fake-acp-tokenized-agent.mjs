import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const chunks = [
  'messy', '\n\n', ',', '\n\n', 'but', '\n\n', 'I', '\n\n', '’ll', '\n\n', 'figure', '\n\n', 'it', '\n\n', 'out', '\n\n', '!',
  '\n\n', '**Inspecting sitemap for clarity**', '\n\n',
  'I', '\n\n', 'feel', '\n\n', 'like', '\n\n', 'I', '\n\n', 'need', '\n\n', 'to', '\n\n', 'provide', '\n\n', 'a', '\n\n', 'direct', '\n\n', 'answer', '.',
];

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'copilot-tokenized-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    for (const text of chunks) {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'copilot-tokenized-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
    }
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
