export function normalizeProviderConnection(input = {}) {
  const source = record(input);
  const id = requiredText(source.id, 'connection id');
  const backendId = requiredText(source.backendId, 'backend id').toLowerCase();
  return Object.freeze({
    id,
    backendId,
    enabled: source.enabled !== false,
    auth: Object.freeze({ ...record(source.auth) }),
    executable: Object.freeze({ ...record(source.executable) }),
    preferences: Object.freeze({ ...record(source.preferences) }),
    createdAt: finiteTimestamp(source.createdAt),
    updatedAt: finiteTimestamp(source.updatedAt),
  });
}

export function patchProviderConnection(connection, patch = {}, now = Date.now()) {
  const current = normalizeProviderConnection(connection);
  const source = record(patch);
  return normalizeProviderConnection({
    ...current,
    ...(source.enabled !== undefined ? { enabled: source.enabled !== false } : {}),
    ...(source.auth ? { auth: { ...current.auth, ...record(source.auth) } } : {}),
    ...(source.executable ? { executable: { ...current.executable, ...record(source.executable) } } : {}),
    ...(source.preferences ? { preferences: { ...current.preferences, ...record(source.preferences) } } : {}),
    createdAt: current.createdAt,
    updatedAt: finiteTimestamp(now),
  });
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function requiredText(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
