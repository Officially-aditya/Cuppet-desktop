import { isProviderTransportFailure, providerFailureMetadata } from '../../provider-failure.mjs';
import {
  clearProviderRuntimeFailure,
  recordProviderRuntimeFailure,
  registerProviderRuntime,
} from '../../runtime-health-registry.mjs';
import { AcpSessionRuntime } from './acp-session.mjs';

/**
 * Owns replacement of an ACP session runtime only at safe pre-turn boundaries.
 *
 * We deliberately never replay runTurn(). A provider turn may already have called
 * tools or changed files before its transport died, so automatic turn replay could
 * duplicate side effects. start()/newSession() are safe to rebuild because the user
 * turn has not begun yet.
 */
export class SupervisedAcpSessionRuntime {
  #factory;
  #runtime;
  #closed = false;
  #generation = 1;
  #restarts = 0;
  #lastFailure = null;
  #providerID = '';
  #unregisterHealth = null;

  constructor(options = {}, { runtimeFactory } = {}) {
    this.#providerID = providerID(options?.descriptor?.id);
    this.#factory = runtimeFactory ?? (() => new AcpSessionRuntime(options));
    this.#runtime = this.#factory();
    this.#unregisterHealth = registerProviderRuntime(this.#providerID, () => this.snapshot());
  }

  async start(options = {}) {
    return this.#beforeTurn('start', options);
  }

  async newSession(options = {}) {
    return this.#beforeTurn('newSession', options);
  }

  async capabilities() {
    return this.#runtime.capabilities();
  }

  setHostHandlers(handlers = {}) {
    return this.#runtime.setHostHandlers?.(handlers);
  }

  async runTurn(input = {}, hooks = {}) {
    try {
      const result = await this.#runtime.runTurn(input, hooks);
      clearProviderRuntimeFailure(this.#providerID);
      return result;
    } catch (error) {
      if (isProviderTransportFailure(error)) {
        this.#lastFailure = failureSnapshot(error);
        recordProviderRuntimeFailure(this.#providerID, this.#lastFailure);
      }
      throw error;
    }
  }

  async cancel() {
    return this.#runtime.cancel?.();
  }

  snapshot() {
    const inner = this.#runtime.snapshot?.() ?? {};
    return Object.freeze({
      ...inner,
      supervisor: {
        generation: this.#generation,
        restarts: this.#restarts,
        lastFailure: this.#lastFailure,
        closed: this.#closed,
      },
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unregisterHealth?.();
    this.#unregisterHealth = null;
    await Promise.resolve(this.#runtime.close?.()).catch(() => undefined);
  }

  async #beforeTurn(method, options) {
    if (this.#closed) throw new Error('ACP runtime supervisor is closed.');
    try {
      const result = await this.#runtime[method](options);
      clearProviderRuntimeFailure(this.#providerID);
      return result;
    } catch (error) {
      if (!canRebuildBeforeTurn(error)) {
        if (isProviderTransportFailure(error)) {
          this.#lastFailure = failureSnapshot(error);
          recordProviderRuntimeFailure(this.#providerID, this.#lastFailure);
        }
        throw error;
      }
      this.#lastFailure = failureSnapshot(error);
      recordProviderRuntimeFailure(this.#providerID, this.#lastFailure);
      await this.#replaceRuntime();
      // A replacement process has no ACP initialization/session state, so even if
      // the caller requested newSession(), its first safe operation must be start().
      try {
        const result = await this.#runtime.start(options);
        clearProviderRuntimeFailure(this.#providerID);
        return result;
      } catch (replacementError) {
        if (isProviderTransportFailure(replacementError)) {
          this.#lastFailure = failureSnapshot(replacementError);
          recordProviderRuntimeFailure(this.#providerID, this.#lastFailure);
        }
        throw replacementError;
      }
    }
  }

  async #replaceRuntime() {
    const previous = this.#runtime;
    await Promise.resolve(previous?.close?.()).catch(() => undefined);
    this.#runtime = this.#factory();
    this.#generation += 1;
    this.#restarts += 1;
  }
}

export function canRebuildBeforeTurn(error) {
  if (!isProviderTransportFailure(error)) return false;
  const metadata = providerFailureMetadata(error);
  // A missing executable cannot be repaired by respawning the same command. Setup
  // must run through the control plane instead.
  return metadata?.category !== 'executable_missing';
}

function failureSnapshot(error) {
  const metadata = providerFailureMetadata(error);
  return Object.freeze({
    code: typeof error?.code === 'string' ? error.code : null,
    category: metadata?.category ?? 'unknown',
    retryable: metadata?.retryable === true,
    at: Date.now(),
  });
}

function providerID(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(id) ? id : '';
}
