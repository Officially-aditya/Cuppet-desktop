import { join } from 'node:path';
import { localProviderOperations } from './local-provider-operations.mjs';
import { discoverProviderCapabilitySnapshot } from './default-registry.mjs';
import { modelCatalogFromCapabilitySnapshot } from './capability-snapshot.mjs';

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

  constructor({
    dataDir,
    userData = process.env.CUPPET_USER_DATA_DIR || join(dataDir, 'host-state'),
    resourcesPath = process.env.CUPPET_RESOURCES_PATH,
    operationsFactory = localProviderOperations,
    capabilityDiscovery = discoverProviderCapabilitySnapshot,
  } = {}) {
    this.#userData = userData;
    this.#resourcesPath = resourcesPath;
    this.#operationsFactory = operationsFactory;
    this.#capabilityDiscovery = capabilityDiscovery;
  }

  async localStatus(providerID) {
    const status = await this.#operations(providerID).status();
    return withControlState(status);
  }

  async localConnect(providerID) {
    const status = await this.#operations(providerID).connect();
    return withControlState(status);
  }

  async localDetect(providerID) {
    const state = await this.#operations(providerID).detect();
    return withControlState(state);
  }

  async localProbe(providerID) {
    const state = await this.#operations(providerID).probe();
    return withControlState(state);
  }

  async localUpdate(providerID) {
    const state = await this.#operations(providerID).update();
    return withControlState(state);
  }

  async models(configuration = {}, { model = '' } = {}) {
    const providerID = text(configuration.providerID || configuration.primary?.providerID).toLowerCase();
    const requestedModel = text(model);
    const configuredModel = requestedModel || text(configuration.primary?.modelID || configuration.model);
    if (!providerID) return unavailable('', 'none', 'No active provider is configured.');

    const discoveryConfiguration = requestedModel
      ? configurationForCandidateModel(configuration, requestedModel)
      : configuration;
    const snapshot = await this.#capabilityDiscovery(discoveryConfiguration, {
      ...(this.#resourcesPath ? { resourcesPath: this.#resourcesPath } : {}),
    });
    return modelCatalogFromCapabilitySnapshot(snapshot, configuredModel);
  }

  #operations(providerID) {
    return this.#operationsFactory(requiredProviderID(providerID), { userData: this.#userData });
  }
}

export function withControlState(status = {}) {
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
  const overall = connected ? 'ready' : installed ? 'needs_auth' : 'needs_install';
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
      runtime: {
        // Status/connect are observation/setup operations. The managed turn runtime
        // owns the live process and reports its lifecycle separately.
        state: connected ? 'available' : 'stopped',
      },
      capabilities: {
        state: connected ? 'unknown' : 'blocked',
      },
    },
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
function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
