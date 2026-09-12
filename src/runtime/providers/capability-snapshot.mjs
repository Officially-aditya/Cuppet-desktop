export class ProviderCapabilitySnapshotStore {
  #snapshots = new Map();

  get(configuration) {
    return this.#snapshots.get(snapshotKey(configuration)) ?? null;
  }

  clear(configuration) {
    this.#snapshots.delete(snapshotKey(configuration));
  }

  async refresh(registry, configuration = {}, options = {}) {
    const providerID = configuredProviderId(configuration);
    if (!providerID) return failureSnapshot('', 'none', 'No active provider is configured.');
    const backend = registry.requireResolved(configuration);
    const key = snapshotKey(configuration);
    try {
      const discovered = await registry.operation(backend.id, 'discoverCapabilities', { configuration, options });
      const snapshot = normalizeCapabilitySnapshot(providerID, backend.transport, discovered);
      // A successful discovery is authoritative even when it advertises zero models.
      // This is what distinguishes a real empty/logout state from a transient probe failure.
      this.#snapshots.set(key, snapshot);
      return snapshot;
    } catch (error) {
      const message = cleanError(error);
      const previous = this.#snapshots.get(key);
      if (previous) {
        return Object.freeze({
          ...previous,
          stale: true,
          discoveryError: message,
          refreshFailedAt: Date.now(),
        });
      }
      return failureSnapshot(providerID, backend.transport, message);
    }
  }
}

export function normalizeCapabilitySnapshot(providerID, transport, discovered = {}) {
  const source = record(discovered);
  const models = uniqueModels(source.models);
  const settings = Array.isArray(source.settings) ? source.settings.map(cloneRecord) : [];
  const defaultModel = exactModel(source.defaultModel, models);
  const currentModel = exactModel(source.currentModel, models);
  const reasoning = normalizeReasoning(source.reasoning);
  return Object.freeze({
    providerID: text(source.providerID) || text(providerID),
    transport: text(transport) || 'custom',
    source: text(source.source) || text(transport) || 'custom',
    available: source.available !== false && models.length > 0,
    models: Object.freeze(models),
    settings: Object.freeze(settings),
    defaultModel,
    currentModel,
    modelDependentSettings: source.modelDependentSettings === true,
    fetchedAt: Date.now(),
    stale: false,
    ...(reasoning ? { reasoning } : {}),
    ...(text(source.error) ? { error: text(source.error) } : {}),
  });
}

export function modelCatalogFromCapabilitySnapshot(snapshot = {}, configuredModel = '') {
  const source = record(snapshot);
  const models = Array.isArray(source.models) ? source.models.map(cloneRecord) : [];
  const configured = text(configuredModel);
  return {
    providerID: text(source.providerID),
    available: source.available === true,
    source: text(source.source) || 'custom',
    ...(source.modelDependentSettings === true ? { modelDependentSettings: true } : {}),
    models,
    defaultModel: exactModel(source.defaultModel, models),
    configuredModel: configured || null,
    fetchedAt: Number.isFinite(Number(source.fetchedAt)) ? Number(source.fetchedAt) : Date.now(),
    ...(source.reasoning ? { reasoning: cloneRecord(source.reasoning) } : {}),
    ...(source.stale === true ? { stale: true } : {}),
    ...(text(source.discoveryError) ? { discoveryError: text(source.discoveryError) } : {}),
    ...(text(source.error) ? { error: text(source.error) } : {}),
  };
}

function failureSnapshot(providerID, transport, error) {
  return Object.freeze({
    providerID: text(providerID),
    transport: text(transport) || 'custom',
    source: text(transport) || 'custom',
    available: false,
    models: Object.freeze([]),
    settings: Object.freeze([]),
    defaultModel: null,
    currentModel: null,
    modelDependentSettings: false,
    fetchedAt: Date.now(),
    stale: false,
    ...(error ? { error: text(error) } : {}),
  });
}

function snapshotKey(configuration) {
  const source = record(configuration);
  const primary = record(source.primary);
  const providerID = configuredProviderId(configuration);
  const endpoint = text(source.baseUrl).toLowerCase();
  const command = text(source.cliCommand);
  // Auth material is intentionally excluded. The host owns secrets and a successful
  // logged-out/empty discovery will replace a prior snapshot authoritatively.
  return `${providerID}\u0000${endpoint}\u0000${command}\u0000${text(primary.providerID)}`;
}
function configuredProviderId(configuration) {
  const source = record(configuration);
  return text(source.providerID || record(source.primary).providerID).toLowerCase();
}
function uniqueModels(value) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = record(raw);
    const id = text(item.id || item.value || item.modelID);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(Object.freeze({
      id,
      label: text(item.label || item.name) || id,
      ...(text(item.description) ? { description: text(item.description) } : {}),
      ...(positiveInt(item.context) ? { context: positiveInt(item.context) } : {}),
      ...(positiveInt(item.outputLimit) ? { outputLimit: positiveInt(item.outputLimit) } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
    }));
  }
  return result;
}
function normalizeReasoning(value) {
  const source = record(value);
  const configId = text(source.configId || source.id);
  const options = [];
  const seen = new Set();
  for (const raw of Array.isArray(source.options) ? source.options : []) {
    const item = record(raw);
    const id = text(item.id || item.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label: text(item.label || item.name) || id, ...(text(item.description) ? { description: text(item.description) } : {}) });
  }
  if (!configId || !options.length) return null;
  const currentValue = text(source.currentValue || source.value);
  return Object.freeze({ configId, currentValue: currentValue || null, options: Object.freeze(options) });
}
function exactModel(value, models) {
  const id = text(value);
  return id && Array.isArray(models) && models.some((item) => item.id === id) ? id : null;
}
function cloneRecord(value) { return structuredClone(record(value)); }
function positiveInt(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0; }
function cleanError(error) { return text(error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]'); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
