import { discoverProviderCapabilitySnapshot } from '../runtime/providers/default-registry.mjs';
import { modelCatalogFromCapabilitySnapshot } from '../runtime/providers/capability-snapshot.mjs';

export { catalogFromCodexModels } from '../runtime/providers/backends/codex.mjs';
export { parseApiCatalog } from '../runtime/providers/backends/api.mjs';
export { discoverAntigravityModels, parseAntigravityModelOutput } from '../runtime/providers/backends/antigravity.mjs';

/**
 * Project the active provider driver's capability snapshot into the renderer's
 * model-catalog compatibility shape.
 *
 * The main process deliberately does not know whether the provider uses ACP,
 * Codex app-server, a headless CLI, or HTTP. Transport/provider quirks belong
 * to the registered driver; this layer only applies a read-only candidate model
 * and returns the normalized snapshot.
 */
export async function fetchProviderModelCatalog(configuration = {}, options = {}) {
  const providerID = text(configuration.providerID || configuration.primary?.providerID).toLowerCase();
  const requestedModel = text(options.model);
  const configuredModel = requestedModel || text(configuration.primary?.modelID || configuration.model);
  if (!providerID) return unavailable('', 'none', 'No active provider is configured.');

  const discoveryConfiguration = requestedModel
    ? configurationForCandidateModel(configuration, requestedModel)
    : configuration;
  const snapshot = await discoverProviderCapabilitySnapshot(discoveryConfiguration, {
    ...options,
    // Electron defines process.resourcesPath. Tests and non-Electron hosts may not.
    resourcesPath: options.resourcesPath ?? process.resourcesPath,
  });
  return modelCatalogFromCapabilitySnapshot(snapshot, configuredModel);
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

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
