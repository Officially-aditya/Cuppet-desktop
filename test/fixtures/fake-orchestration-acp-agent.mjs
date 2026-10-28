import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let mcpChild;
let mcp;
let model = 'provider/primary';
const sessionId = `fixture-${process.pid}`;
const modelOptions = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'provider/primary', name: 'Primary' }, { value: 'provider/secondary', name: 'Secondary' }] }];

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  void handle(message).catch((error) => {
    if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
  });
});

async function handle(message) {
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (message.method === 'session/new') {
    const server = message.params?.mcpServers?.find((entry) => entry.name === 'cuppet-runtime');
    if (server) {
      mcpChild = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
      mcp = new McpClient(mcpChild);
      await mcp.request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      mcp.notify('notifications/initialized', {});
    }
    return write({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: modelOptions() } });
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') model = message.params.value;
    return write({ jsonrpc: '2.0', id: message.id, result: { configOptions: modelOptions() } });
  }
  if (message.method === 'session/prompt') {
    const prompt = JSON.stringify(message.params.prompt ?? '');
    let text;
    if (prompt.includes('Create a concise chat title')) text = 'ACP delegation';
    else if (prompt.includes('You are a Cuppet subagent')) {
      if (model !== 'provider/secondary') throw new Error(`wrong worker model: ${model}`);
      const listed = await mcp.request('tools/list', {});
      if (listed.tools.some((tool) => tool.name === 'cuppet_delegate')) throw new Error('workers must not delegate');
      if (!listed.tools.some((tool) => tool.name === 'cuppet_plan')) throw new Error('worker tools missing');
      if (Number(process.env.FAKE_ORCHESTRATION_WORKER_DELAY_MS) > 0) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_ORCHESTRATION_WORKER_DELAY_MS)));
      text = 'Worker used secondary.';
    } else {
      if (model !== 'provider/primary') throw new Error(`wrong primary model: ${model}`);
      const listed = await mcp.request('tools/list', {});
      if (!listed.tools.some((tool) => tool.name === 'cuppet_delegate')) throw new Error('delegation tool missing');
      const response = await mcp.request('tools/call', { name: 'cuppet_delegate', arguments: { tasks: [{ name: 'First', task: 'Inspect one area' }, { name: 'Second', task: 'Inspect another area' }] } });
      if (response.isError || !response.content?.[0]?.text?.includes('Worker used secondary.')) throw new Error('delegated results missing');
      text = 'Both workers returned.';
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    return write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
  if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

class McpClient {
  #child; #next = 1; #pending = new Map();
  constructor(child) {
    this.#child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
    child.once('exit', () => { for (const pending of this.#pending.values()) pending.reject(new Error('MCP child exited')); this.#pending.clear(); });
  }
  request(method, params) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) { this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
}

process.on('exit', () => { try { mcpChild?.kill(); } catch {} });
