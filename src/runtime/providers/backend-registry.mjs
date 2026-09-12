import { invokeProviderOperation, normalizeProviderOperations, providerOperationSupport } from './operations.mjs';

export class ProviderBackendRegistry {
  #backends = new Map();

  register(definition) {
    const backend = normalizeBackendDefinition(definition);
    if (this.#backends.has(backend.id)) throw new Error(`Provider backend '${backend.id}' is already registered.`);
    this.#backends.set(backend.id, backend);
    return backend;
  }

  get(id) {
    return this.#backends.get(normalizeId(id)) ?? null;
  }

  require(id) {
    const backend = this.get(id);
    if (!backend) throw new Error(`Unknown provider backend '${normalizeId(id)}'.`);
    return backend;
  }

  resolve(value) {
    const id = configuredBackendId(value);
    const exact = this.get(id);
    if (exact) return exact;
    for (const backend of this.#backends.values()) {
      if (typeof backend.matches !== 'function') continue;
      try {
        if (backend.matches(value) === true) return backend;
      } catch {}
    }
    return null;
  }

  requireResolved(value) {
    const backend = this.resolve(value);
    if (!backend) throw new Error(`No provider backend can handle '${configuredBackendId(value) || 'unknown'}'.`);
    return backend;
  }

  list() {
    return Object.freeze([...this.#backends.values()]);
  }

  operationSupport(id) {
    return this.require(id).operationSupport;
  }

  operation(id, name, context = {}) {
    const backend = this.require(id);
    return invokeProviderOperation(backend.operations, name, context);
  }

  resolvedOperation(value, name, context = {}) {
    const backend = this.requireResolved(value);
    return invokeProviderOperation(backend.operations, name, context);
  }

  createRuntime(connection, context = {}) {
    const backend = this.require(connection?.backendId);
    return backend.createRuntime({ connection, context });
  }

  createConfiguredRuntime(configuration, context = {}) {
    const backend = this.requireResolved(configuration);
    return backend.createRuntime({ configuration, context });
  }
}

export function normalizeBackendDefinition(input = {}) {
  const source = record(input);
  const id = normalizeId(source.id);
  if (!id) throw new TypeError('backend id is required.');
  const label = text(source.label) || id;
  const transport = text(source.transport) || 'custom';
  if (typeof source.createRuntime !== 'function') throw new TypeError(`Provider backend '${id}' requires createRuntime().`);
  const operations = normalizeProviderOperations({ ...record(source.operations), createRuntime: source.createRuntime });
  return Object.freeze({
    id,
    label,
    transport,
    ...(typeof source.matches === 'function' ? { matches: source.matches } : {}),
    // Keep the legacy metadata flags descriptive. operationSupport is the
    // authoritative map for whether an operation is actually invokable.
    supportsInstallation: source.supportsInstallation === true || typeof operations.install === 'function',
    supportsAuthentication: source.supportsAuthentication !== false,
    operations,
    operationSupport: providerOperationSupport(operations),
    createRuntime: source.createRuntime,
  });
}

function configuredBackendId(value) {
  if (typeof value === 'string') return normalizeId(value);
  const source = record(value);
  const primary = record(source.primary);
  return normalizeId(source.backendId || source.providerID || primary.providerID);
}
function normalizeId(value) {
  return text(value).toLowerCase();
}
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
