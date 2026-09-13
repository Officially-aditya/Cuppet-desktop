import { join } from 'node:path';
import { localProviderOperations } from './local-provider-operations.mjs';
import { discoverProviderCapabilitySnapshot } from './default-registry.mjs';
import { modelCatalogFromCapabilitySnapshot } from './capability-snapshot.mjs';
import { providerRuntimeHealth } from './runtime-health-registry.mjs';

/**
 * Runtime-owned provider lifecycle authority.
 *
 * Electron may persist host secrets/settings, but it must not independently decide
 * whether a local provider is installed, authenticated, healthy, or capable. Those
 * observations belong to the same runtime process that will actually execute turns.
 */
export class ProviderControlPlane {
  #userData;
  #resourcesPath;
  #operationsFactory;
  #capabilityDiscovery;
  #runtimeHealth;
  #capabilityState = new Map();

  constructor({
    dataDir,
    userData = process.env.CUPPET_USER_DATA_DIR || join(dataDir, 'host-state'),
    resourcesPath = process.env.CUPPET_RESOURCES_PATH,
    operationsFactory = localProviderOperations,
    capabilityDiscovery = discoverProviderCapabilitySnapshot,
    runtimeHealth = providerRuntimeHealth,
  } = {}) {
    this.#userData = userData;
    this.#resourcesPath = resourcesPath;
    this.#operationsFactory = operationsFactory;
    this.#capabilityDiscovery = capabilityDiscovery;
    this.#runtimeHealth = runtimeHealth;
  }

  async localStatus(providerID) {
    const id = requiredProviderID(providerID);
    const status = await this.#operations(id).status();
    return withControlState(status, this.#runtimeHealth(id), this.#capabilityState.get(id));
  }

  async localConnect(providerID) {
    const id = requiredProviderID(providerID);
    const status = await this.#operations(id).connect();
    if (status.connected !== true && status.available !== true) this.#capabilityState.delete(id);
    return withControlState(status, this.#runtimeHealth(id), this.#capabilityState.get(id));
  }

  async localDetect(providerID) {
    const id = requiredProviderID(providerID);
    const state = await this.#operations(id).detect();
    return withControlState(state, this.#runtimeHealth(id), this.#capabilityState.get(id));
  }

  async localProbe(providerID) {
    const id = requiredProviderID(providerID);
    const state = await this.#operations(id).probe();
    if (state.connected !== true && state.available !== true) this.#capabilityState.delete(id);
    return withControlState(state, this.#runtimeHealth(id), this.#capabilityState.get(id));
  }

  async localUpdate(providerID) {
    const id = requiredProviderID(providerID);
    const state = await this.#operations(id).update();
    return withControlState(state, this.#runtimeHealth(id), this.#capabilityState.get(id));
  }

  async models(configuration = {}, { model = '' } = {}) {
    const providerID = text(configuration.providerID || configuration.primary?.providerID).toLowerCase();
    const requestedModel = text(model);
    const configuredModel = requestedModel || text(configuration.primary?.modelID || configuration.model);
    if (!providerID) return unavailable('', 'none', 'No active provider is configured.');

    const discoveryConfiguration = requestedModel
      ? configurationForCandidateModel(configuration, requestedModel)
      : configuration;
    const previous = this.#capabilityState.get(providerID);
    this.#capabilityState.set(providerID, { state: 'loading', ...(previous?.fetchedAt ? { fetchedAt: previous.fetchedAt } : {}) });
    try {
      const snapshot = await this.#capabilityDiscovery(discoveryConfiguration, {
        ...(this.#resourcesPath ? { resourcesPath: this.#resourcesPath } : {}),
      });
      this.#capabilityState.set(providerID, capabilityControlState(snapshot));
      return modelCatalogFromCapabilitySnapshot(snapshot, configuredModel);
    } catch (error) {
      this.#capabilityState.set(providerID, {
        state: previous?.state === 'ready' || previous?.state === 'stale' ? 'stale' : 'failed',
        fetchedAt: previous?.fetchedAt ?? 0,
        error: cleanError(error),
      });
      throw error;
    }
  }

  #operations(providerID) {
    return this.#operationsFactory(requiredProviderID(providerID), { userData: this.#userData });
  }
}

export function withControlState(status = {}, runtimeHealth = null, capabilityState = null) {
  const installed = status.installed === true || status.installation?.detected === true;
  const connected = status.connected === true || status.available === true;
  const installationState = !installed
    ? 'missing'
    : status.installation?.ownedByCuppet === true
      ? 'cuppet_managed'
      : 'external';
  const authenticationState = connected
    ? 'authenticated'
    : installed
      ? 'required'
      : 'unknown';
  const runtime = normalizeRuntimeHealth(runtimeHealth);
  const capabilities = connected ? normalizeCapabilityControl(capabilityState) : blockedCapabilities();
  const runtimeNeedsRetry = runtime.state === 'crashed' || runtime.state === 'unhealthy';
  const overall = !installed
    ? 'needs_install'
    : !connected
      ? 'needs_auth'
      : runtimeNeedsRetry
        ? 'needs_retry'
        : 'ready';
  return {
    ...status,
    control: {
      overall,
      installation: {
        state: installationState,
        executable: text(status.installation?.executable) || null,
        version: text(status.version || status.installation?.version) || null,
        source: text(status.installation?.source) || null,
        ownedByCuppet: status.installation?.ownedByCuppet === true,
        canUpdate: status.installation?.canUpdate === true,
        identity: cloneIdentity(status.installation?.identity),
      },
      authentication: {
        state: authenticationState,
        probe: text(status.probe) || null,
      },
      runtime,
      capabilities,
    },
  };
}

function capabilityControlState(snapshot = {}) {
  const source = record(snapshot);
  const state = source.stale === true
    ? 'stale'
    : text(source.discoveryError) || text(source.error)
      ? 'failed'
      : 'ready';
  return {
    state,
    fetchedAt: nonnegativeInteger(source.fetchedAt),
    modelCount: Array.isArray(source.models) ? source.models.length : 0,
    error: text(source.discoveryError || source.error) || null,
  };
}

function normalizeCapabilityControl(value) {
  const source = record(value);
  const state = ['unknown', 'loading', 'ready', 'stale', 'failed'].includes(source.state) ? source.state : 'unknown';
  return {
    state,
    fetchedAt: nonnegativeInteger(source.fetchedAt),
    modelCount: nonnegativeInteger(source.modelCount),
    error: text(source.error) || null,
  };
}

function blockedCapabilities() {
  return { state: 'blocked', fetchedAt: 0, modelCount: 0, error: null };
}

function normalizeRuntimeHealth(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = ['stopped', 'starting', 'ready', 'busy', 'unhealthy', 'crashed'].includes(source.state)
    ? source.state
    : 'stopped';
  return {
    state,
    activeProcesses: nonnegativeInteger(source.activeProcesses),
    readyProcesses: nonnegativeInteger(source.readyProcesses),
    busyProcesses: nonnegativeInteger(source.busyProcesses),
    generation: nonnegativeInteger(source.generation),
    restarts: nonnegativeInteger(source.restarts),
    lastFailure: cloneFailure(source.lastFailure),
  };
}

function unavailable(providerID, source, error) {
  return {
    providerID,
    available: false,
    source,
    models: [],
    defaultModel: null,
    configuredModel: null,
    fetchedAt: Date.now(),
    ...(error ? { error } : {}),
  };
}

function configurationForCandidateModel(configuration, modelID) {
  const source = { ...record(configuration), model: modelID, primaryEffort: '' };
  delete source.effort;
  const primary = { ...record(source.primary), modelID };
  delete primary.variant;
  source.primary = primary;
  return source;
}

function requiredProviderID(value) {
  const id = text(value).toLowerCase();
  if (!id || !/^[a-z0-9._-]+$/.test(id)) throw new Error('A valid local provider id is required.');
  return id;
}

function cloneIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : null;
}
function cloneFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    code: text(value.code).slice(0, 120) || null,
    category: text(value.category).slice(0, 120) || 'unknown',
    retryable: value.retryable === true,
    at: nonnegativeInteger(value.at),
  };
}
function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
function cleanError(error) {
  return text(error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
}
function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
