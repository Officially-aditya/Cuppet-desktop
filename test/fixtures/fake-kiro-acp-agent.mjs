import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

let model = 'kiro/model-a';
let effort = 'low';
const sessionId = 'kiro-session';

function models() {
  return {
    availableModels: [
      { modelId: 'kiro/model-a', name: 'Kiro Model A' },
      { modelId: 'kiro/model-b', name: 'Kiro Model B' },
    ],
    currentModelId: model,
  };
}

function efforts() {
  const available = model === 'kiro/model-b' ? ['medium', 'xhigh', 'max'] : ['low', 'high'];
  if (!available.includes(effort)) effort = available[0];
  return available;
}

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
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId, models: models() } });
    return;
  }
  if (message.method === 'session/set_model') {
    const requested = String(message.params?.modelId ?? '');
    if (!models().availableModels.some((item) => item.modelId === requested)) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown model ${requested}` } });
      return;
    }
    model = requested;
    efforts();
    write({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === '_kiro.dev/commands/options') {
    if (message.params?.command !== 'effort') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unsupported command options' } });
      return;
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        options: efforts().map((value) => ({
          value,
          label: value === 'xhigh' ? 'Extra High' : value[0].toUpperCase() + value.slice(1),
          current: value === effort,
        })),
        hasMore: false,
      },
    });
    return;
  }
  if (message.method === '_kiro.dev/commands/execute') {
    const command = message.params?.command;
    if (command?.command !== 'effort') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unsupported command execution' } });
      return;
    }
    const requested = String(command?.args?.value ?? '');
    if (!efforts().includes(requested)) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unsupported effort ${requested}` } });
      return;
    }
    effort = requested;
    write({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/prompt') {
    if (!Array.isArray(message.params?.prompt) || message.params.content) {
      // Mirror the live Kiro failure mode closely: a legacy `content` request does
      // not produce a useful completion and would eventually hit Cuppet liveness.
      return;
    }
    const prompt = message.params.prompt.map((item) => String(item?.text ?? '')).join('');
    if (prompt.includes('ASSERT_CONFIG') && (model !== 'kiro/model-b' || effort !== 'max')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `wrong config ${model}/${effort}` } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/notification', params: { sessionId, update: { sessionUpdate: 'AgentMessageChunk', content: { type: 'text', text: 'Kiro ready.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
