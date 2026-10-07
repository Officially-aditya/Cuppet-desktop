import {
  normalizeProviderConfiguration,
  providerProjection,
  providerRequest,
  resolveAdvertisedSelection,
} from '../provider-policy.mjs';
import { resolveProviderBackend } from '../providers/default-registry.mjs';

// Account and CLI providers own authentication on the desktop. HTTP providers
// still require the host's API key; remote devices never supply credentials.
function providerOwnsAuthentication(providerID) {
  return resolveProviderBackend({ providerID }).transport !== 'http';
}

export function remoteProviderProjection(input = {}) {
  const projection = providerProjection(input);
  return {
    ...projection,
    configured: projection.configured || Boolean(projection.primary && providerOwnsAuthentication(projection.primary.providerID)),
  };
}

export function remoteProviderRequest(input, selection) {
  const config = normalizeProviderConfiguration(input);
  const selected = resolveAdvertisedSelection(config, selection);
  const ownsAuthentication = providerOwnsAuthentication(selected.providerID);
  if (!ownsAuthentication) providerRequest(config, selected);
  // Forward the same full configuration used by desktop chats. The runtime
  // resolves transport aliases and retains secondary models and effort metadata.
  const execution = normalizeProviderConfiguration({ ...config, providerID: selected.providerID,
    apiKey: ownsAuthentication ? '' : config.apiKey, primary: selected });
  return { ...execution, modelID: selected.modelID, primaryEffort: selected.variant ?? '' };
}
