const DEFAULT_TIMEOUT_MS = 15_000;
const SESSION_NEW_RETRY_DELAY_MS = 250;

export class AcpRpcChannel {
  #process;
  #label;
  #pending = new Map();
  #nextId = 1;
  #closed = false;
  #notificationHandler = async () => {};
  #requestHandler = async (message) => {
    const error = new Error(`Unsupported ACP client request: ${message.method}`);
    error.rpcCode = -32601;
    throw error;
  };

  constructor({ processHandle, label = 'ACP provider' }) {
    this.#process = processHandle;
    this.#label = label;
    processHandle.onLine((line) => this.#onLine(line));
    processHandle.onExit(({ code, signal, expected }) => {
      if (expected || this.#closed) return;
      this.#failAll(new Error(`${this.#label} ACP exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`));
    });
  }

  ready() { return this.#process.ready(); }
  stderr() { return this.#process.stderr(); }
  setNotificationHandler(handler) { this.#notificationHandler = typeof handler === 'function' ? handler : async () => {}; }
  setRequestHandler(handler) { this.#requestHandler = typeof handler === 'function' ? handler : this.#requestHandler; }

  async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      return await this.#requestOnce(method, params, timeoutMs);
    } catch (error) {
      if (!isTransientSessionNewFailure(method, error) || this.#closed) throw error;
      await delay(SESSION_NEW_RETRY_DELAY_MS);
      return this.#requestOnce(method, params, timeoutMs);
    }
  }

  #requestOnce(method, params, timeoutMs) {
    if (this.#closed) return Promise.reject(new Error(`${this.#label} ACP channel is closed.`));
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve(value) { clearTimeout(timer); resolveRequest(value); },
        reject(error) { clearTimeout(timer); rejectRequest(error); },
      });
      this.#process.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    if (this.#closed) return;
    this.#process.write({ jsonrpc: '2.0', method, params });
  }

  terminate() { this.#process.terminate(); }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error(`${this.#label} ACP channel closed.`));
    this.#process.close();
  }

  #onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(acpRpcError(message.error));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      void Promise.resolve(this.#requestHandler(message)).then(
        (result) => this.#process.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} }),
        (error) => this.#process.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: error?.rpcCode ?? -32000, message: cleanError(error) },
        }),
      );
      return;
    }

    if (message.method) void Promise.resolve(this.#notificationHandler(message)).catch(() => undefined);
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.#pending.clear();
  }
}

function acpRpcError(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const baseMessage = typeof source.message === 'string' && source.message.trim()
    ? source.message.trim()
    : JSON.stringify(source);
  const detail = safeRpcData(source.data);
  const error = new Error(detail ? `${baseMessage || 'ACP request failed.'} (${detail})` : baseMessage || 'ACP request failed.');
  const code = Number(source.code);
  if (Number.isInteger(code)) error.rpcCode = code;
  if (Object.prototype.hasOwnProperty.call(source, 'data')) error.rpcData = source.data;
  return error;
}

function isTransientSessionNewFailure(method, error) {
  return method === 'session/new'
    && Number(error?.rpcCode) === -32603
    && /internal error/i.test(cleanError(error));
}

function safeRpcData(value) {
  if (value === undefined || value === null) return '';
  try {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    return rendered.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 800);
  } catch {
    return '';
  }
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function cleanError(error) { return error instanceof Error ? error.message : String(error ?? 'Unknown ACP error'); }
