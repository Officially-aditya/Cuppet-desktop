import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let sessionId;
let sessionCount = 0;
let prompt;
let received = [];
let cleanup;
const update = (kind, text) => write({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } },
} });

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { sessionCapabilities: { close: {} } } } });
  } else if (message.method === 'session/new') {
    if (!cleanup) {
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
      const entry = config.plugins.find((plugin) => plugin.options?.endpoint);
      const plugin = await import(pathToFileURL(join(entry.package, 'index.js')).href);
      cleanup = await plugin.default.setup({ options: entry.options, session: {
        async prompt(input) {
          if (!prompt || input.sessionID !== sessionId || input.delivery !== 'steer') throw new Error('Steering did not target the running session');
          if (input.text === 'reject this') throw new Error('Native steering rejected');
          received.push(input);
          if (input.text === 'finish now') {
            setTimeout(() => {
              update('agent_message_chunk', JSON.stringify({ sessionCount, received }));
              write({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
              prompt = null;
            }, 25);
          }
        },
      } });
    }
    sessionId = `opencode-native-${++sessionCount}`;
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
  } else if (message.method === 'session/prompt') {
    if (prompt) throw new Error('A second ACP prompt must not be started');
    prompt = message;
    received = [];
    update('agent_thought_chunk', 'Still reasoning without tools.');
  } else if (message.method === 'session/close') {
    write({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/cancel' && prompt) {
    write({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
    prompt = null;
  }
});
lines.on('close', () => { cleanup?.(); process.exit(0); });
