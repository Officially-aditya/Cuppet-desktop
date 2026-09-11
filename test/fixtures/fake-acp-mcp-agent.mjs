import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const acp = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let mcpChild = null;
let mcp = null;
let mcpStderr = '';
let toolResult = '';

acp.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  void handle(message).catch((error) => {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
  });
});

async function handle(message) {
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: {} }, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    const server = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers.find((item) => item?.name === 'cuppet-runtime') : null;
    if (!server) throw new Error('Cuppet MCP server was not supplied to session/new');
    mcpChild = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...Object.fromEntries((server.env ?? []).map((item) => [item.name, item.value])) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    mcpChild.stderr.on('data', (chunk) => { mcpStderr = `${mcpStderr}${String(chunk)}`.slice(-4_000); });
    mcp = new JsonLineClient(mcpChild, () => mcpStderr);
    const initialized = await mcp.request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fake-acp-agent', version: '1.0.0' } });
    if (!initialized?.capabilities?.tools) throw new Error('Cuppet MCP server did not advertise tools');
    mcp.notify('notifications/initialized', {});
    const listed = await mcp.request('tools/list', {});
    for (const name of ['cuppet_plan', 'tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate']) {
      if (!listed?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} was not advertised through Cuppet MCP`);
    }
    const called = await mcp.request('tools/call', { name: 'cuppet_plan', arguments: { action: 'overview' } });
    if (called?.isError) throw new Error(called?.content?.[0]?.text || 'cuppet_plan failed');
    toolResult = called?.content?.map((item) => item?.text || '').join('') || '';
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'mcp-session', configOptions: [] } });
    return;
  }
  if (message.method === 'session/prompt') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mcp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `MCP:${toolResult}` } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } });
    return;
  }
  if (message.method === 'session/cancel') return;
}

class JsonLineClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #stderr;
  constructor(child, stderr) {
    this.#child = child;
    this.#stderr = stderr;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    child.once('error', (error) => this.#fail(error));
    child.once('exit', (code) => this.#fail(new Error(`MCP child exited ${code}${this.#stderr() ? `: ${this.#stderr().trim()}` : ''}`)));
  }
  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method, params) { this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  #fail(error) { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
}

function shutdown() {
  try { mcpChild?.stdin?.end(); } catch {}
  try { mcpChild?.kill(); } catch {}
}
process.on('exit', shutdown);
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
