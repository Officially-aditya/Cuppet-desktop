import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';

export const TST_PROTOCOL_VERSION = 'cuppet.tst.v3';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class TstClient extends EventEmitter {
  #socket; #nextID = 1; #buffer = Buffer.alloc(0); #pending = new Map(); #closed = false;
  constructor(socket) {
    super(); this.#socket = socket;
    socket.on('data', (chunk) => this.#consume(chunk));
    socket.on('error', (error) => this.#disconnect(error));
    socket.on('close', () => this.#disconnect(new Error('TST socket closed')));
  }
  static async connect(socketPath, token) {
    const socket = await new Promise((resolve, reject) => {
      const candidate = createConnection(socketPath); candidate.once('connect', () => resolve(candidate)); candidate.once('error', reject);
    });
    const client = new TstClient(socket);
    const initialized = await client.call('initialize', { token, notifications: true });
    if (initialized?.protocol !== TST_PROTOCOL_VERSION) {
      client.destroy(); throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${initialized?.protocol ?? 'unknown'}`);
    }
    return client;
  }
  call(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('TST client is closed'));
    const id = this.#nextID++; const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (!payload.length || payload.length > MAX_FRAME_BYTES) return Promise.reject(new Error('TST request exceeds frame limit'));
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(Buffer.concat([header, payload]), (error) => { if (!error) return; this.#pending.delete(id); reject(error); });
    });
  }
  get connected() { return !this.#closed; }
  destroy() { if (this.#closed) return; this.#closed = true; this.#socket.destroy(); this.#failAll(new Error('TST client closed')); }
  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0); if (!length || length > MAX_FRAME_BYTES) return this.destroy();
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4); this.#buffer = this.#buffer.subarray(length + 4);
      let response; try { response = JSON.parse(payload.toString('utf8')); } catch { return this.destroy(); }
      if (response?.method) { this.emit('notification', response); continue; }
      const pending = this.#pending.get(response?.id); if (!pending) continue; this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result);
    }
  }
  #failAll(error) { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
  #disconnect(error) { if (this.#closed) return; this.#closed = true; this.#failAll(error); this.emit('disconnect', error); }
}

export class TstBridge {
  #socketPath; #token; #client; #lastError;
  constructor({ socketPath = process.env.CUPPET_TST_SOCKET, token = process.env.CUPPET_TST_TOKEN } = {}) { this.#socketPath = socketPath; this.#token = token; }
  get configured() { return Boolean(this.#socketPath && this.#token); }
  get status() { return { configured: this.configured, connected: Boolean(this.#client?.connected), lastError: this.#lastError ?? null, protocol: TST_PROTOCOL_VERSION }; }
  async call(method, params = {}) {
    if (!this.configured) throw new Error('TST is not configured');
    const client = await this.#ensure();
    try { return await client.call(method, params); } catch (error) { this.#lastError = cleanError(error); if (!client.connected) this.#client = undefined; throw error; }
  }
  async prepareContext(sessionID, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0) {
    return this.call('context.prepare', { session_id: sessionID, query: String(query).slice(0, 6000), mode, projection_budget: Math.min(Math.max(Math.floor(projectionBudget), 0), 16384), hints: hints.slice(0, 32), observations: observations.slice(0, 256) });
  }
  async refreshStm(input) { return this.call('stm.refresh', boundedRefresh(input)); }
  async turnCompleted(sessionID) { return this.call('turn.completed', { session_id: sessionID }); }
  async observeMemory(sessionID, observation) { return this.call('memory.observe', { session_id: sessionID, ...observation }); }
  async queryMemory(sessionID, query, limit = 20) { return this.call('memory.query', { session_id: sessionID, query, limit: Math.min(Math.max(limit, 1), 40) }); }
  async recordEvidence(sessionID, memoryID, kind, reference, success = true) { return this.call('evidence.record', { session_id: sessionID, memory_id: memoryID, kind, reference: String(reference).slice(0, 500), success }); }
  close() { this.#client?.destroy(); this.#client = undefined; }
  async #ensure() {
    if (this.#client?.connected) return this.#client;
    try {
      const client = await TstClient.connect(this.#socketPath, this.#token); this.#lastError = undefined; this.#client = client;
      client.on('disconnect', (error) => { this.#lastError = cleanError(error); if (this.#client === client) this.#client = undefined; });
      return client;
    } catch (error) { this.#lastError = cleanError(error); throw error; }
  }
}

function boundedRefresh(input = {}) {
  return {
    ...input,
    query: typeof input.query === 'string' ? input.query.slice(0, 6000) : undefined,
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 6000) : undefined,
    requirements: input.requirements?.slice?.(0, 64), outcomes: input.outcomes?.slice?.(0, 64), constraints: input.constraints?.slice?.(0, 64), observations: input.observations?.slice?.(0, 64), candidates: input.candidates?.slice?.(0, 64),
    explicit_paths: input.explicit_paths?.slice?.(0, 128), tool_paths: input.tool_paths?.slice?.(0, 128), validated_paths: input.validated_paths?.slice?.(0, 128), graph_paths: input.graph_paths?.slice?.(0, 128), file_evidence: input.file_evidence?.slice?.(0, 128),
  };
}
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
