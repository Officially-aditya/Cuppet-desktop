import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (message.method === 'session/new') {
    if (Array.isArray(message.params?.mcpServers) && message.params.mcpServers.length) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'external MCP servers are unsupported in this Kiro fixture' } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kiro-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    if (!Array.isArray(message.params?.content) || message.params.prompt) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'expected Kiro content field' } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/notification', params: { sessionId: 'kiro-session', update: { sessionUpdate: 'AgentMessageChunk', content: { type: 'text', text: 'Kiro ready.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
