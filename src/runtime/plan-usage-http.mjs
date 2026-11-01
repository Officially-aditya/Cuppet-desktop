const MAX_USAGE_BYTES = 1024 * 1024;

export function usageError(message, status = 'error', httpStatus = null) {
  return Object.assign(new Error(message), { usageStatus: status, httpStatus });
}

export async function requestUsageJSON(url, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, provider = 'Your provider', ...options } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal, redirect: 'error' });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (status === 401 || status === 403) throw usageError(provider + ' could not authorize plan usage. Reconnect your account in Settings → Account.', 'signed-out', status);
      if (status === 429) throw usageError(provider + ' is temporarily rate limiting usage checks. Try refreshing later.', 'error', status);
      throw usageError(provider + ' could not load plan usage (HTTP ' + status + '). Try refreshing.', 'error', status);
    }
    if (Number(response.headers.get('content-length')) > MAX_USAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw usageError(provider + ' returned an oversized usage report.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw usageError(provider + ' returned an empty usage report.');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_USAGE_BYTES) throw usageError(provider + ' returned an oversized usage report.');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (error?.usageStatus) throw error;
    // Never include a response body, request headers, token, or fetch diagnostic in IPC.
    throw usageError(provider + (signal.aborted ? ' usage request timed out. Try refreshing.' : ' could not read the usage report. Check your connection and try refreshing.'));
  }
}
