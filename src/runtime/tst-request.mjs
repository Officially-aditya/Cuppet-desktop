import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();
export function tstOptions(options = {}) { return { signal: requests.getStore()?.signal, ...options }; }
export function withTstRequest(options, operation) { return requests.run(tstOptions(options), operation); }
export function tstAbortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
export function checkTstSignal(signal) { if (signal?.aborted) throw tstAbortError(); }

// Cancelling one waiter must not cancel a shared connection/start used by other sessions.
export function waitForTst(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(tstAbortError()); }
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener('abort', onAbort); fn(value); };
    const onAbort = () => finish(reject, tstAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
