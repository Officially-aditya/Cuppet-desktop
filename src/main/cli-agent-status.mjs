import {
  installSpec,
  localProviderOperations,
  loginSpec,
  updateSpec,
} from './local-provider-operations.mjs';
import { probeOpenCodeAuthentication } from './opencode-auth.mjs';

/**
 * Compatibility facade for the current Electron settings IPC.
 *
 * Provider lifecycle behavior now lives in explicit operations so callers that
 * only need detection/probing do not accidentally install or authenticate.
 */
export async function cliAgentStatus(providerID, options = {}) {
  const status = await localProviderOperations(providerID, options).status();
  return reconcileOpenCodeStatus(providerID, status, options);
}

export async function cliAgentConnect(providerID, options = {}) {
  await localProviderOperations(providerID, options).connect();
  return cliAgentStatus(providerID, options);
}

export async function cliAgentDetect(providerID, options = {}) {
  return localProviderOperations(providerID, options).detect();
}

export async function cliAgentProbe(providerID, options = {}) {
  const state = await localProviderOperations(providerID, options).probe();
  if (providerID !== 'opencode' || !state.installed) return state;
  const status = await reconcileOpenCodeStatus(providerID, {
    ...state,
    action: state.connected ? 'ready' : 'connect',
    message: '',
  }, options);
  return {
    ...state,
    connected: status.connected,
    available: status.available,
    probe: status.connected ? 'provider' : 'not-authenticated',
    ...(status.probeError ? { probeError: status.probeError } : {}),
  };
}

export async function cliAgentInstall(providerID, options = {}) {
  return localProviderOperations(providerID, options).install();
}

export async function cliAgentUpdate(providerID, options = {}) {
  return localProviderOperations(providerID, options).update();
}

export async function cliAgentAuthenticate(providerID, options = {}) {
  const state = await localProviderOperations(providerID, options).authenticate();
  if (providerID !== 'opencode') return state;
  return cliAgentProbe(providerID, options);
}

async function reconcileOpenCodeStatus(providerID, status, options) {
  if (providerID !== 'opencode' || status?.installed !== true) return status;
  const executable = status?.installation?.executable || 'opencode';
  let auth;
  let probeError = null;
  try {
    auth = await probeOpenCodeAuthentication(executable, { runImpl: options.runImpl });
  } catch (error) {
    auth = { connected: false, source: 'probe-error' };
    probeError = cleanError(error);
  }

  const connected = auth.connected === true;
  const version = status.version ?? null;
  return {
    ...status,
    connected,
    available: connected,
    action: connected ? 'ready' : 'connect',
    probe: connected ? 'provider' : 'not-authenticated',
    ...(probeError ? { probeError } : {}),
    message: connected
      ? `OpenCode is connected and ready to use in Cuppet${version ? ` · ${version}` : ''}.`
      : probeError
        ? `OpenCode is installed, but Cuppet could not verify provider credentials: ${probeError}`
        : 'OpenCode is installed, but no authenticated provider credentials were found. Run `opencode auth login` once, then reconnect.',
  };
}

function cleanError(error) {
  return String(error instanceof Error ? error.message : error ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

export { installSpec, loginSpec, updateSpec };
