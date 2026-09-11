import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BRIDGE_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const SERVER_SCRIPT = fileURLToPath(new URL('./cuppet-mcp-stdio.mjs', import.meta.url));

export class CuppetMcpToolSession {
  #sessionId;
  #backendId;
  #server = null;
  #endpoint = '';
  #token = randomBytes(32).toString('hex');
  #connections = new Set();
  #definitions = [];
  #executeTool = null;
  #signal = null;
  #queue = Promise.resolve();
  #closed = false;

  constructor({ sessionId, backendId }) {
    this.#sessionId = requiredText(sessionId, 'sessionId');
    this.#backendId = requiredText(backendId, 'backendId');
  }

  async start() {
    if (this.#server) return this;
    if (this.#closed) throw new Error('Cuppet MCP tool session is closed.');
    this.#endpoint = bridgeEndpoint();
    if (process.platform !== 'win32') await rm(this.#endpoint, { force: true }).catch(() => undefined);
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => { this.#server?.off('listening', onListening); rejectListen(error); };
      const onListening = () => { this.#server?.off('error', onError); resolveListen(); };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.#endpoint);
    });
    return this;
  }

  setTurn({ tools = [], executeTool, signal = null } = {}) {
    if (this.#closed) throw new Error('Cuppet MCP tool session is closed.');
    this.#definitions = normalizeTools(tools);
    this.#executeTool = typeof executeTool === 'function' ? executeTool : null;
    this.#signal = signal ?? null;
  }

  descriptor() {
    if (!this.#server || !this.#endpoint) throw new Error('Cuppet MCP tool session must be started before creating its descriptor.');
    return {
      name: 'cuppet-runtime',
      command: process.execPath,
      args: [SERVER_SCRIPT],
      env: [
        { name: 'CUPPET_MCP_BRIDGE_ENDPOINT', value: this.#endpoint },
        { name: 'CUPPET_MCP_BRIDGE_TOKEN', value: this.#token },
        { name: 'CUPPET_MCP_SESSION_ID', value: this.#sessionId },
        { name: 'CUPPET_MCP_BACKEND_ID', value: this.#backendId },
        // Electron's executable can be used as a Node runtime for the bundled bridge.
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      ],
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#definitions = [];
    this.#executeTool = null;
    this.#signal = null;
    for (const socket of this.#connections) {
      try { socket.destroy(); } catch {}
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise((resolveClose) => server.close(() => resolveClose())).catch(() => undefined);
    if (this.#endpoint && process.platform !== 'win32') await rm(this.#endpoint, { force: true }).catch(() => undefined);
    this.#endpoint = '';
  }

  #accept(socket) {
    this.#connections.add(socket);
    socket.setEncoding('utf8');
    let authenticated = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BRIDGE_LINE_BYTES) {
        socket.destroy(new Error('Cuppet MCP bridge frame exceeded limit.'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error('Invalid Cuppet MCP bridge JSON.')); return; }
        void this.#handleBridgeMessage(socket, message, () => authenticated, () => { authenticated = true; });
      }
    });
    socket.on('close', () => this.#connections.delete(socket));
    socket.on('error', () => this.#connections.delete(socket));
  }

  async #handleBridgeMessage(socket, message, isAuthenticated, markAuthenticated) {
    const id = message?.id;
    if (!isAuthenticated()) {
      if (message?.method !== 'hello' || !sameToken(message?.token, this.#token)) {
        this.#write(socket, { id, error: { message: 'Cuppet MCP bridge authentication failed.' } });
        socket.destroy();
        return;
      }
      markAuthenticated();
      this.#write(socket, { id, result: { ok: true } });
      return;
    }

    if (message?.method === 'tools/list') {
      this.#write(socket, { id, result: { tools: this.#definitions } });
      return;
    }
    if (message?.method === 'tools/call') {
      const task = this.#queue.then(() => this.#callTool(message?.params, id));
      this.#queue = task.catch(() => undefined);
      try { this.#write(socket, { id, result: await task }); }
      catch (error) { this.#write(socket, { id, error: { message: cleanError(error) } }); }
      return;
    }
    this.#write(socket, { id, error: { message: `Unsupported Cuppet MCP bridge method: ${String(message?.method ?? '')}` } });
  }

  async #callTool(params, requestId) {
    const name = text(params?.name);
    if (!name || !this.#definitions.some((tool) => tool.name === name)) {
      return toolFailure(`Unknown Cuppet tool: ${name || '(missing)'}`);
    }
    if (!this.#executeTool) return toolFailure('Cuppet tool execution is unavailable outside an active turn.');
    if (this.#signal?.aborted) return toolFailure('Cuppet tool execution was cancelled.');
    const args = record(params?.arguments);
    try {
      const result = await this.#executeTool({
        id: `mcp_${safeId(this.#backendId)}_${safeId(this.#sessionId)}_${safeId(requestId)}`.slice(0, 180),
        name,
        arguments: JSON.stringify(args),
      });
      return mcpResult(result);
    } catch (error) {
      return toolFailure(cleanError(error));
    }
  }

  #write(socket, value) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
  }
}

function normalizeTools(definitions) {
  const tools = [];
  const seen = new Set();
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    const fn = record(definition?.function);
    const name = text(fn.name);
    if (!name || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    tools.push({
      name,
      description: String(fn.description ?? '').slice(0, 8_000),
      inputSchema: Object.keys(record(fn.parameters)).length ? record(fn.parameters) : { type: 'object', properties: {} },
    });
    if (tools.length >= 128) break;
  }
  return tools;
}

function mcpResult(result) {
  const content = [];
  for (const item of Array.isArray(result?.contentItems) ? result.contentItems.slice(0, 8) : []) {
    if (item?.type === 'inputText' && typeof item.text === 'string') {
      content.push({ type: 'text', text: capText(item.text) });
      continue;
    }
    if (item?.type === 'inputImage' && typeof item.imageUrl === 'string') {
      const match = item.imageUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
  }
  if (!content.length) content.push({ type: 'text', text: capText(result?.output ?? '') });
  return { content, isError: result?.success !== true };
}
function toolFailure(message) { return { content: [{ type: 'text', text: capText(message) }], isError: true }; }
function capText(value) { const textValue = String(value ?? ''); return Buffer.byteLength(textValue) <= MAX_RESULT_BYTES ? textValue : `${Buffer.from(textValue).subarray(0, MAX_RESULT_BYTES - 64).toString('utf8')}\n… Cuppet tool result truncated.`; }
function bridgeEndpoint() { return process.platform === 'win32' ? `\\\\.\\pipe\\cuppet-mcp-${process.pid}-${randomUUID()}` : join(tmpdir(), `cuppet-mcp-${process.pid}-${randomUUID()}.sock`); }
function sameToken(value, expected) { const left = Buffer.from(String(value ?? '')); const right = Buffer.from(String(expected ?? '')); return left.length === right.length && timingSafeEqual(left, right); }
function safeId(value) { return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown'; }
function requiredText(value, label) { const result = text(value); if (!result) throw new TypeError(`${label} is required.`); return result; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? 'Unknown tool error')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 2_000); }
