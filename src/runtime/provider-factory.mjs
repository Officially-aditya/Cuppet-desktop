import { providerRequest } from './provider-policy.mjs';
import { createProviderRuntime, nativeProviderKind } from './providers/default-registry.mjs';
import { recordProviderUsage } from './usage-ledger.mjs';
import { sanitizeProviderError } from './credential-sanitization.mjs';

export function createChatProvider(configuration = {}) {
  return trackUsage(createUntrackedChatProvider(configuration), providerIdentity(configuration));
}

export function createUntrackedChatProvider(configuration = {}) {
  try {
    const provider = createProviderRuntime(configuration);
    if (!provider || typeof provider.stream !== 'function') return provider;
    const stream = provider.stream.bind(provider);
    provider.stream = async (...args) => {
      try { return await stream(...args); }
      catch (error) { throw sanitizeProviderError(error, configuration); }
    };
    return provider;
  } catch (error) {
    throw sanitizeProviderError(error, configuration);
  }
}

function trackUsage(provider, identity) {
  if (!provider || typeof provider.stream !== 'function') return provider;
  const stream = provider.stream.bind(provider);
  provider.stream = async (...args) => {
    const result = await stream(...args);
    // Usage bookkeeping must never turn a successful provider response into a failed generation.
    await recordProviderUsage({ ...identity, usage: result?.usage }).catch(() => undefined);
    return result;
  };
  return provider;
}

function providerIdentity(configuration) {
  const source = record(configuration);
  const primary = record(source.primary);
  let providerID = text(source.providerID) || text(primary.providerID);
  let modelID = text(source.modelID) || text(source.model) || text(primary.modelID);
  if (!providerID || !modelID) {
    try {
      const request = providerRequest(configuration, 'primary');
      providerID ||= text(request?.providerID);
      modelID ||= text(request?.modelID) || text(request?.model);
    } catch {}
  }
  return { providerID: providerID || 'unknown', modelID: modelID || 'unknown' };
}

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export { nativeProviderKind };
