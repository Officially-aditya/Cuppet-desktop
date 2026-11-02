import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { checkTstSignal, tstAbortError, tstOptions, waitForTst } from './tst-request.mjs';

export const TST_PROTOCOL_VERSION = 'cuppet.tst.v3';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
// A daemon that accepted the request but never answers must not be able to hang tool calls forever.
const DEFAULT_CALL_TIMEOUT_MS = Math.max(1_000, Number(process.env.CUPPET_TST_CALL_TIMEOUT_MS) || 60_000);

export class TstClient extends EventEmitter {
  #socket; #nextID = 1; #buffer = Buffer.alloc(0); #pending = new Map(); #closed = false; #capabilities = new Set();
  constructor(socket) {
    super(); this.#socket = socket;
    socket.on('data', (chunk) => this.#consume(chunk));
    socket.on('error', (error) => this.#disconnect(error));
    socket.on('close', () => this.#disconnect(new Error('TST socket closed')));
  }
  static async connect(socketPath, token, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal, connectImpl = createConnection } = {}) {
    if (signal?.aborted) throw connectionClosed();
    const socket = await new Promise((resolve, reject) => {
      const candidate = connectImpl(socketPath);
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); candidate.removeListener('error', onError); candidate.removeListener('connect', onConnect); };
      const onAbort = () => { cleanup(); candidate.destroy(); reject(connectionClosed()); };
      const onError = (error) => { cleanup(); candidate.destroy(); reject(error); };
      const onConnect = () => { cleanup(); resolve(candidate); };
      candidate.once('connect', onConnect); candidate.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error(`TST socket connection timed out after ${timeoutMs}ms`); error.code = 'TST_TIMEOUT';
          onError(error);
        }, timeoutMs);
        timer.unref?.();
      }
      if (signal?.aborted) onAbort();
    });
    const client = new TstClient(socket);
    const onAbort = () => client.destroy();
    signal?.addEventListener('abort', onAbort, { once: true });
    let initialized;
    try {
      if (signal?.aborted) throw connectionClosed();
      initialized = await client.call('initialize', { token, notifications: true }, { timeoutMs, signal });
      if (signal?.aborted) throw connectionClosed();
    } catch (error) { client.destroy(); throw error; }
    finally { signal?.removeEventListener('abort', onAbort); }
    if (initialized?.protocol !== TST_PROTOCOL_VERSION) {
      client.destroy(); throw new Error(`TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${initialized?.protocol ?? 'unknown'}`);
    }
    client.#capabilities = new Set(Array.isArray(initialized?.capabilities) ? initialized.capabilities.map(String) : []);
    return client;
  }
  call(method, params = {}, options = {}) {
    const { timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal } = tstOptions(options);
    if (signal?.aborted) return Promise.reject(tstAbortError());
    if (this.#closed) return Promise.reject(transportError('TST client is closed'));
    const id = this.#nextID++; const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (!payload.length || payload.length > MAX_FRAME_BYTES) return Promise.reject(new Error('TST request exceeds frame limit'));
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length);
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn, value) => {
        if (!this.#pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        finish(reject, tstAbortError());
        if (this.supports('request.cancel') && !this.#closed) {
          const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }));
          const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
          this.#socket.write(Buffer.concat([size, body]), () => {});
        }
      };
      this.#pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error(`TST ${method} timed out after ${timeoutMs}ms`); error.code = 'TST_TIMEOUT';
          finish(reject, error);
        }, timeoutMs);
        timer.unref?.();
      }
      this.#socket.write(Buffer.concat([header, payload]), (error) => { if (error) finish(reject, transportError(error.message)); });
    });
  }
  supports(capability) { return this.#capabilities.has(capability); }
  get capabilities() { return [...this.#capabilities].sort(); }
  get connected() { return !this.#closed; }
  destroy() { if (this.#closed) return; this.#closed = true; this.#socket.destroy(); this.#failAll(transportError('TST client closed')); }
  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0); if (!length || length > MAX_FRAME_BYTES) return this.destroy();
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4); this.#buffer = this.#buffer.subarray(length + 4);
      let response; try { response = JSON.parse(payload.toString('utf8')); } catch { return this.destroy(); }
      if (response?.method) { this.emit('notification', response); continue; }
      const pending = this.#pending.get(response?.id); if (!pending) continue;
      if (response.error) pending.reject(new Error(response.error.message)); else pending.resolve(response.result);
    }
  }
  #failAll(error) { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
  #disconnect(error) { error = transportError(error.message); if (this.#closed) return; this.#closed = true; this.#failAll(error); this.emit('disconnect', error); }
}

export class TstBridge {
  #socketPath; #token; #client; #lastError; #lastCapabilities = []; #connecting; #connectTimeoutMs; #generation = 0; #connectController;
  constructor({ socketPath = process.env.CUPPET_TST_SOCKET, token = process.env.CUPPET_TST_TOKEN, connectTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) { this.#socketPath = socketPath; this.#token = token; this.#connectTimeoutMs = connectTimeoutMs; }
  get configured() { return Boolean(this.#socketPath && this.#token); }
  get status() { return { configured: this.configured, connected: Boolean(this.#client?.connected), lastError: this.#lastError ?? null, protocol: TST_PROTOCOL_VERSION, capabilities: this.#client?.capabilities ?? this.#lastCapabilities }; }
  async call(method, params = {}, options = {}) {
    if (!this.configured) throw new Error('TST is not configured');
    options = tstOptions(options); checkTstSignal(options.signal);
    const client = await waitForTst(this.#ensure(), options.signal); checkTstSignal(options.signal);
    try { return await client.call(method, params, options); } catch (error) { if (this.#client === client) { this.#lastError = cleanError(error); if (!client.connected) this.#client = undefined; } throw error; }
  }
  async supports(capability, options = {}) {
    options = tstOptions(options); checkTstSignal(options.signal);
    if (!this.configured) return false;
    const client = await waitForTst(this.#ensure(), options.signal); checkTstSignal(options.signal);
    return client.supports(capability);
  }
  async prepareContext(sessionID, query, hints = [], observations = [], mode = 'foreground', projectionBudget = 0, options = {}) {
    return this.call('context.prepare', { session_id: sessionID, query: String(query).slice(0, 6000), mode, projection_budget: Math.min(Math.max(Math.floor(projectionBudget), 0), 16384), hints: hints.slice(0, 32), observations: observations.slice(0, 256) }, options);
  }
  async refreshStm(input, options = {}) { return this.call('stm.refresh', boundedRefresh(input), options); }
  async turnCompleted(sessionID, options = {}) { return this.call('turn.completed', { session_id: sessionID }, options); }
  async observeMemory(sessionID, observation, options = {}) { return this.call('memory.observe', { session_id: sessionID, ...observation }, options); }
  async queryMemory(sessionID, query, limit = 20, options = {}) { return this.call('memory.query', { session_id: sessionID, query, limit: Math.min(Math.max(limit, 1), 40) }, options); }
  async rememberMemory(sessionID, { key, value, scope = 'project', pinned = false, fileHashes = {} } = {}, options = {}) {
    return this.call('memory.remember', { session_id: sessionID, key: String(key ?? '').slice(0, 240), value: String(value ?? '').slice(0, 4000), scope: normalizeMemoryScope(scope), pinned: Boolean(pinned), file_hashes: boundedHashes(fileHashes) }, options);
  }
  async forgetMemory(sessionID, key, options = {}) { return this.call('memory.forget', { session_id: sessionID, key: String(key ?? '').slice(0, 240) }, options); }
  async clearMemory(sessionID, scope = 'session', options = {}) { return this.call('memory.forget', { session_id: sessionID, clear_scope: normalizeMemoryScope(scope) }, options); }
  async recordEvidence(sessionID, memoryID, kind, reference, success = true, contentHash = undefined, options = {}) { return this.call('evidence.record', { session_id: sessionID, memory_id: memoryID, kind, reference: String(reference).slice(0, 500), success, ...(contentHash ? { content_hash: String(contentHash).slice(0, 128) } : {}) }, options); }
  async graphQuery(query, prefix, limit = 12, options = {}) { return this.call('graph.query', { query: String(query).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: Math.min(Math.max(Math.floor(limit), 1), 32) }, options); }
  async graphLocate(pattern, prefix, limit = 12, options = {}) { return this.call('graph.locate', { pattern: String(pattern).slice(0, 512), ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: Math.min(Math.max(Math.floor(limit), 1), 12) }, options); }
  async graphList(prefix, limit = 100, options = {}) { return this.call('graph.list', { ...(prefix ? { prefix: String(prefix).slice(0, 512) } : {}), limit: Math.min(Math.max(Math.floor(limit), 1), 512) }, options); }
  async graphWorkspace(limit = 100, options = {}) { return this.call('graph.workspace', { limit: Math.min(Math.max(Math.floor(limit), 1), 512) }, options); }
  async graphTraceSummary(query, direction = 'both', depth = 2, limit = 12, options = {}) { return this.call('graph.trace_summary', { query: String(query).slice(0, 512), direction: ['callers', 'callees', 'both'].includes(direction) ? direction : 'both', depth: Math.min(Math.max(Math.floor(depth), 1), 4), limit: Math.min(Math.max(Math.floor(limit), 1), 12) }, options); }
  async resolveEditTargets(path, query, expectedHash = undefined, limit = 12, options = {}) {
    if (!(await this.supports('edit.resolve_targets', options))) throw new Error('Connected TST daemon does not support revision-bound edit targets. Upgrade the bundled TST runtime.');
    return this.call('edit.resolve_targets', { path: String(path).slice(0, 1024), query: String(query).slice(0, 512), ...(expectedHash ? { expected_hash: String(expectedHash).slice(0, 128) } : {}), limit: Math.min(Math.max(Math.floor(limit), 1), 64) }, options);
  }
  async parseStaged(path, baseHash, content, options = {}) {
    if (!(await this.supports('edit.parse_staged', options))) throw new Error('Connected TST daemon does not support staged parsing. Upgrade the bundled TST runtime.');
    return this.call('edit.parse_staged', { path: String(path).slice(0, 1024), base_hash: baseHash || null, content: String(content) }, options);
  }
  async refreshGraphPaths(paths, options = {}) {
    if (!(await this.supports('graph.refresh_paths', options))) throw new Error('Connected TST daemon does not support the graph refresh barrier. Upgrade the bundled TST runtime.');
    return this.call('graph.refresh_paths', { paths: [...new Set((Array.isArray(paths) ? paths : []).map((value) => String(value).slice(0, 1024)))].slice(0, 64) }, options);
  }
  close() {
    this.#generation++;
    this.#connectController?.abort(); this.#connectController = undefined;
    this.#client?.destroy(); this.#client = undefined; this.#connecting = undefined;
  }
  async #ensure() {
    if (this.#client?.connected) return this.#client;
    if (!this.#connecting) {
      const generation = this.#generation; const controller = new AbortController();
      this.#connectController = controller;
      const connecting = this.#connect(generation, controller.signal).finally(() => {
        if (this.#connecting === connecting) { this.#connecting = undefined; this.#connectController = undefined; }
      });
      this.#connecting = connecting;
    }
    return this.#connecting;
  }
  async #connect(generation, signal) {
    try {
      const client = await TstClient.connect(this.#socketPath, this.#token, { timeoutMs: this.#connectTimeoutMs, signal });
      if (generation !== this.#generation || signal.aborted) { client.destroy(); throw connectionClosed(); }
      this.#lastError = undefined; this.#client = client; this.#lastCapabilities = client.capabilities;
      client.on('disconnect', (error) => {
        if (this.#client !== client) return;
        this.#lastError = cleanError(error); this.#lastCapabilities = client.capabilities; this.#client = undefined;
      });
      return client;
    } catch (error) { if (generation === this.#generation) this.#lastError = cleanError(error); throw error; }
  }
}

function connectionClosed() { const error = new Error('TST connection closed while initializing'); error.name = 'AbortError'; return error; }
function boundedRefresh(input = {}) {
  return {
    ...input,
    query: typeof input.query === 'string' ? input.query.slice(0, 6000) : undefined,
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 6000) : undefined,
    requirements: input.requirements?.slice?.(0, 64), outcomes: input.outcomes?.slice?.(0, 64), constraints: input.constraints?.slice?.(0, 64), observations: input.observations?.slice?.(0, 64), candidates: input.candidates?.slice?.(0, 64),
    explicit_paths: input.explicit_paths?.slice?.(0, 128), tool_paths: input.tool_paths?.slice?.(0, 128), validated_paths: input.validated_paths?.slice?.(0, 128), graph_paths: input.graph_paths?.slice?.(0, 128), file_evidence: input.file_evidence?.slice?.(0, 128),
  };
}
function normalizeMemoryScope(value) { const scope = String(value ?? 'session').toLowerCase(); return ['session', 'project', 'global'].includes(scope) ? scope : 'session'; }
function boundedHashes(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).slice(0, 64).flatMap(([path, hash]) => typeof path === 'string' && typeof hash === 'string' ? [[path.slice(0, 512), hash.slice(0, 128)]] : [])); }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }

function transportError(message) { const error = new Error(message); error.code = 'TST_DISCONNECTED'; return error; }
