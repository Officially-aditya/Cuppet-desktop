import {
  installSpec,
  localProviderOperations,
  loginSpec,
  updateSpec,
} from './local-provider-operations.mjs';

/**
 * Compatibility facade for the current Electron settings IPC.
 *
 * Provider lifecycle behavior now lives in explicit operations so callers that
 * only need detection/probing do not accidentally install or authenticate.
 */
export async function cliAgentStatus(providerID, options = {}) {
  return localProviderOperations(providerID, options).status();
}

export async function cliAgentConnect(providerID, options = {}) {
  return localProviderOperations(providerID, options).connect();
}

export async function cliAgentDetect(providerID, options = {}) {
  return localProviderOperations(providerID, options).detect();
}

export async function cliAgentProbe(providerID, options = {}) {
  return localProviderOperations(providerID, options).probe();
}

export async function cliAgentInstall(providerID, options = {}) {
  return localProviderOperations(providerID, options).install();
}

export async function cliAgentUpdate(providerID, options = {}) {
  return localProviderOperations(providerID, options).update();
}

export async function cliAgentAuthenticate(providerID, options = {}) {
  return localProviderOperations(providerID, options).authenticate();
}

export { installSpec, loginSpec, updateSpec };
