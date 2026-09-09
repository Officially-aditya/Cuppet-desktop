import { OpenAICompatibleChatProvider } from './provider.mjs';
import { providerRequest } from './provider-policy.mjs';
import { createNativeProvider, nativeProviderKind } from './native-provider.mjs';

export function createChatProvider(configuration = {}) {
  const kind = resolvedNativeKind(configuration);
  if (kind) {
    const sourceFetch = configuration?.fetchImpl ?? globalThis.fetch;
    const prepared = typeof sourceFetch === 'function'
      ? { ...configuration, fetchImpl: nativeFetchGuard(kind, sourceFetch) }
      : configuration;
    return createNativeProvider(prepared);
  }
  return new OpenAICompatibleChatProvider(configuration);
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

export { nativeProviderKind };
