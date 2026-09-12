import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let model = 'provider/model-a';
let effort = 'low';
let sessionId = 'opencode-acp-session';

function configOptions() {
  const efforts = model === 'provider/model-b' ? ['medium', 'max'] : ['low', 'high'];
  if (!efforts.includes(effort)) effort = efforts[0];
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
      options: [
        { value: 'provider/model-a', name: 'Model A' },
        { value: 'provider/model-b', name: 'Model B' },
      ],
    },
    {
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort,
      options: efforts.map((value) => ({ value, name: value })),
    },
  ];
}

function validateEnvironment() {
  let config = {};
  try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); } catch {}
  const requiredDisabled = ['bash', 'edit', 'write', 'patch', 'read', 'glob', 'grep', 'webfetch', 'websearch', 'task', 'todowrite', 'lsp', 'skill', 'question'];
  const tools = config?.tools && typeof config.tools === 'object' ? config.tools : {};
  const permission = config?.permission && typeof config.permission === 'object' ? config.permission : {};
  const missing = requiredDisabled.filter((name) => tools[name] !== false);
  if (missing.length) return `OpenCode built-in tools not disabled: ${missing.join(',')}`;
  if (permission['*'] !== 'deny') return 'OpenCode default tool permission is not deny';
  if (permission['cuppet-runtime_*'] !== 'allow' || permission['cuppet_runtime_*'] !== 'allow') return 'Cuppet MCP tool permission is not allowed';
  if (process.env.OPENCODE_DISABLE_AUTOUPDATE !== '1') return 'OpenCode auto-update not disabled';
  return '';
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const environmentError = validateEnvironment();
    if (environmentError) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: environmentError } });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }

  if (message.method === 'session/new') {
    if (process.env.FAKE_OPENCODE_REQUIRE_MCP === '1') {
      const servers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
      const server = servers.find((item) => item?.name === 'cuppet-runtime');
      if (!server?.command || !Array.isArray(server?.env) || !server.env.length) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'missing Cuppet MCP server' } });
        return;
      }
    }
    sessionId = `opencode-acp-${Date.now()}`;
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: configOptions() } });
    return;
  }

  if (message.method === 'session/set_config_option') {
    if (message.params?.configId === 'model') model = String(message.params.value);
    if (message.params?.configId === 'effort') effort = String(message.params.value);
    write({ jsonrpc: '2.0', id: message.id, result: { configOptions: configOptions() } });
    return;
  }

  if (message.method === 'session/prompt') {
    const prompt = Array.isArray(message.params?.prompt)
      ? message.params.prompt.map((item) => String(item?.text ?? '')).join('')
      : '';
    if (prompt.includes('AUTH_ERROR')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'provider authentication required', data: { providerId: 'anthropic' } } });
      return;
    }
    if (prompt.includes('NO_PROVIDER')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'No provider available', data: { service: 'session', errorName: 'APIError' } } });
      return;
    }
    if (model !== 'provider/model-b' || effort !== 'max') {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `wrong config ${model}/${effort}` } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenCode ACP ready.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } } });
  }
});
