import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

class BridgeClient {
  #socket;
  #pending = new Map();
  #nextId = 1;
  #ready;

  constructor(path, authToken) {
    this.#socket = createConnection(path);
    this.#socket.setEncoding('utf8');
    let buffer = '';
    this.#socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = this.#pending.get(message?.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'Cuppet MCP bridge error'));
        else pending.resolve(message.result ?? {});
      }
    });
    this.#socket.on('error', (error) => this.#failAll(error));
    this.#socket.on('close', () => this.#failAll(new Error('Cuppet MCP bridge closed.')));
    this.#ready = new Promise((resolveReady, rejectReady) => {
      this.#socket.once('connect', () => {
        this.request('hello', {}, { token: authToken }).then(resolveReady, rejectReady);
      });
      this.#socket.once('error', rejectReady);
    });
  }

  ready() { return this.#ready; }

  request(method, params = {}, extra = {}) {
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.#socket.write(`${JSON.stringify({ id, method, params, ...extra })}\n`);
    });
  }

  close() { try { this.#socket.end(); } catch {} }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.#pending.clear();
  }
}

const endpoint = String(process.env.CUPPET_MCP_BRIDGE_ENDPOINT ?? '');
const token = String(process.env.CUPPET_MCP_BRIDGE_TOKEN ?? '');
if (!endpoint || !token) {
  process.stderr.write('Cuppet MCP bridge configuration is missing.\n');
  process.exit(2);
}

const bridge = new BridgeClient(endpoint, token);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  void handleMcpMessage(message).catch((error) => {
    if (Object.prototype.hasOwnProperty.call(message ?? {}, 'id')) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: cleanError(error) } });
    }
  });
});
input.on('close', () => { bridge.close(); });
process.on('SIGTERM', () => { bridge.close(); process.exit(0); });
process.on('SIGINT', () => { bridge.close(); process.exit(0); });

async function handleMcpMessage(message) {
  const method = String(message?.method ?? '');
  const hasId = Object.prototype.hasOwnProperty.call(message ?? {}, 'id');
  if (!method) return;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (!hasId) return;

  if (method === 'initialize') {
    await bridge.ready();
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: typeof message?.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2026-07-28',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cuppet-runtime', title: 'Cuppet Runtime Tools', version: '0.9.0-alpha.1' },
        instructions: 'Use Cuppet tools for repository inspection, batched editing, validation, memory, planning, questions, and connected capabilities. Prefer structured Cuppet tools over raw filesystem or terminal fallbacks.',
      },
    });
    return;
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id: message.id, result: await bridge.request('tools/list', {}) });
    return;
  }
  if (method === 'tools/call') {
    const params = record(message.params);
    write({ jsonrpc: '2.0', id: message.id, result: await bridge.request('tools/call', { name: params.name, arguments: record(params.arguments) }) });
    return;
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported MCP method: ${method}` } });
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? 'Unknown MCP error')).slice(0, 2_000); }
