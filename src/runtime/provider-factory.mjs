import { OpenAICompatibleChatProvider } from './provider.mjs';
import { providerRequest } from './provider-policy.mjs';
import { createNativeProvider, nativeProviderKind } from './native-provider.mjs';
import { CodexSubscriptionProvider } from './codex-provider.mjs';
import { recordProviderUsage } from './usage-ledger.mjs';

export function createChatProvider(configuration = {}) {
  let provider;
  if (String(configuration?.providerID ?? '').toLowerCase() === 'codex') provider = new CodexSubscriptionProvider(configuration);
  else {
    const kind = resolvedNativeKind(configuration);
    if (kind) {
      const sourceFetch = configuration?.fetchImpl ?? globalThis.fetch;
      const prepared = typeof sourceFetch === 'function'
        ? { ...configuration, fetchImpl: nativeFetchGuard(kind, sourceFetch) }
        : configuration;
      provider = createNativeProvider(prepared);
    } else provider = new OpenAICompatibleChatProvider(configuration);
  }
  return trackUsage(provider, providerIdentity(configuration));
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

function resolvedNativeKind(configuration) {
  try { return nativeProviderKind(providerRequest(configuration, 'primary').providerID); }
  catch { return nativeProviderKind(configuration?.providerID); }
}

function nativeFetchGuard(kind, inner) {
  return async (url, init = {}) => {
    let nextUrl = String(url);
    let nextInit = init;

    if (kind === 'vertex-gemini') {
      try {
        const parsed = new URL(nextUrl);
        const key = parsed.searchParams.get('key');
        if (key) {
          parsed.searchParams.delete('key');
          nextUrl = parsed.toString();
          nextInit = { ...init, headers: { ...(init.headers ?? {}), 'x-goog-api-key': key } };
        }
      } catch {}
    }

    if (kind === 'gemini-interactions' && typeof nextInit.body === 'string') {
      try {
        const body = JSON.parse(nextInit.body);
        if (Array.isArray(body?.input)) {
          body.input = body.input.map((item) => item?.type === 'function_result' && Array.isArray(item.result)
            ? { ...item, result: { content: item.result } }
            : item);
          nextInit = { ...nextInit, body: JSON.stringify(body) };
        }
      } catch {}
    }

    return inner(nextUrl, nextInit);
  };
}

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export { nativeProviderKind };
