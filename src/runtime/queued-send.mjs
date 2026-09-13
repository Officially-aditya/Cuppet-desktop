const SECRET_KEY = /(?:api.?key|secret|token|password|authorization|cookie|credential)/i;

export function queueSafeSendParams(params = {}) {
  const source = record(params);
  return {
    ...sanitizeValue(source),
    provider: sanitizeProvider(source.provider),
  };
}

export function rehydrateQueuedSendParams(params = {}, currentProvider = {}) {
  const source = record(params);
  const queuedProvider = record(source.provider);
  const current = record(currentProvider);
  const queuedIdentity = providerExecutionIdentity(queuedProvider);
  const currentIdentity = providerExecutionIdentity(current);
  if (stableJson(queuedIdentity) !== stableJson(currentIdentity)) {
    throw new Error('Queued message was not dispatched because Provider settings changed while it was waiting. Send it again with the current provider.');
  }
  return {
    ...structuredClone(source),
    provider: structuredClone(current),
  };
}

export function providerExecutionIdentity(value = {}) {
  const source = record(value);
  const primary = record(source.primary);
  const secondary = record(source.secondary);
  return {
    providerID: text(source.providerID),
    baseUrl: text(source.baseUrl),
    primary: {
      providerID: text(primary.providerID),
      modelID: text(primary.modelID),
      variant: text(primary.variant),
    },
    secondary: {
      providerID: text(secondary.providerID),
      modelID: text(secondary.modelID),
      variant: text(secondary.variant),
    },
  };
}

export function containsPersistedCredential(value) {
  if (Array.isArray(value)) return value.some(containsPersistedCredential);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SECRET_KEY.test(key) || containsPersistedCredential(item));
}

function sanitizeProvider(value) {
  return sanitizeValue(record(value), 0, true);
}

function sanitizeValue(value, depth = 0, provider = false) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, provider ? 4000 : 100_000);
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeValue(item, depth + 1, provider));
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (provider && SECRET_KEY.test(key)) continue;
    output[key] = sanitizeValue(item, depth + 1, provider);
  }
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2000) : '';
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
