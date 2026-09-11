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

  createRuntime(connection, context = {}) {
    const backend = this.require(connection?.backendId);
    return backend.createRuntime({ connection, context });
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
    supportsInstallation: source.supportsInstallation === true || typeof operations.install === 'function',
    supportsAuthentication: source.supportsAuthentication !== false && typeof operations.authenticate === 'function',
    operations,
    operationSupport: providerOperationSupport(operations),
    createRuntime: source.createRuntime,
  });
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
