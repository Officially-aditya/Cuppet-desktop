import { sanitizeProviderError } from './credential-sanitization.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Keep provider credentials on the configured origin, including when a gateway
// redirects a request. Same-origin redirects retain normal Fetch semantics.
export async function fetchProvider(fetchImpl, input, init = {}) {
  let url = new URL(input);
  const origin = url.origin;
  let options = { ...init, redirect: 'manual' };
  const credentials = { headers: init.headers, query: Object.fromEntries(url.searchParams) };
  try {
    for (let redirects = 0; ; redirects++) {
      options.signal?.throwIfAborted?.();
      const response = await fetchImpl(url.toString(), options);
      if (!REDIRECTS.has(response.status)) return response;
      const location = response.headers?.get?.('location');
      if (!location) return response;
      const next = new URL(location, url);
      await response.body?.cancel?.().catch(() => undefined);
      if (next.origin !== origin || next.username || next.password) {
        const error = new Error('Provider redirect to another origin was blocked. Configure the final provider endpoint in Settings.');
        error.name = 'ProviderConfigurationError';
        throw error;
      }
      if (redirects >= 20) throw new Error('Provider request exceeded the redirect limit.');
      const method = String(options.method || 'GET').toUpperCase();
      if ((response.status === 303 && method !== 'GET' && method !== 'HEAD')
        || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        const headers = new Headers(options.headers);
        for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
        options = { ...options, method: 'GET', body: undefined, headers };
      }
      url = next;
    }
  } catch (error) {
    throw sanitizeProviderError(error, credentials);
  }
}
