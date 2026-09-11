import { emptyProviderCapabilities, normalizeProviderCapabilities } from './capabilities.mjs';
import { activityFromLegacyProviderEvent, providerActivity } from './activity.mjs';

export function assertProviderRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('Provider runtime must be an object.');
  for (const method of ['start', 'capabilities', 'runTurn', 'cancel', 'close']) {
    if (typeof runtime[method] !== 'function') throw new TypeError(`Provider runtime requires ${method}().`);
  }
  return runtime;
}

export function legacyProviderRuntime(provider, options = {}) {
  if (!provider || typeof provider.stream !== 'function') throw new TypeError('Legacy provider requires stream().');
  const source = record(options);
  let activeController = null;
  let started = false;
  let closed = false;

  return assertProviderRuntime({
    async start() {
      if (closed) throw new Error('Provider runtime is closed.');
      started = true;
      return Object.freeze({ state: 'ready' });
    },

    async capabilities() {
      if (typeof source.capabilities === 'function') {
        return normalizeProviderCapabilities(await source.capabilities());
      }
      if (source.capabilities) return normalizeProviderCapabilities(source.capabilities);
      return emptyProviderCapabilities();
    },

    async runTurn(input = {}, hooks = {}) {
      if (closed) throw new Error('Provider runtime is closed.');
      if (!started) await this.start();
      if (activeController) throw new Error('Provider runtime already has an active turn.');

      const controller = new AbortController();
      activeController = controller;
      const externalSignal = hooks.signal;
      const onAbort = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) onAbort();
      else externalSignal?.addEventListener?.('abort', onAbort, { once: true });

      const emitActivity = async (activity) => {
        if (!activity || typeof hooks.onActivity !== 'function') return;
        await hooks.onActivity(activity);
      };

      try {
        return await provider.stream(input.messages ?? [], {
          signal: controller.signal,
          projectRoot: input.projectRoot ?? null,
          onDelta: async (delta) => {
            const text = typeof delta === 'string' ? delta : String(delta ?? '');
            if (!text) return;
            await emitActivity(providerActivity('activity.text.delta', { text }));
            await hooks.onText?.(text);
          },
          onProviderEvent: async (event) => {
            await emitActivity(activityFromLegacyProviderEvent(event));
          },
        });
      } finally {
        externalSignal?.removeEventListener?.('abort', onAbort);
        activeController = null;
      }
    },

    async cancel() {
      activeController?.abort(new Error('Provider turn cancelled.'));
    },

    async close() {
      if (closed) return;
      closed = true;
      activeController?.abort(new Error('Provider runtime closed.'));
      activeController = null;
      await provider.close?.();
    },
  });
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
