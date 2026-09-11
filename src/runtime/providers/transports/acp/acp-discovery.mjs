import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../../../local-cli-descriptors.mjs';
import { modelRuntimeSetting, reasoningRuntimeSetting } from '../../capabilities.mjs';
import { AcpSessionRuntime } from './acp-session.mjs';

/**
 * Discover provider-authoritative ACP model/config metadata through the same
 * runtime and capability parser used for actual turns.
 *
 * Discovery deliberately uses two authority phases:
 * 1. a clean provider session with no Cuppet model/effort override determines
 *    the provider default and baseline model list;
 * 2. when the user has an explicit model, a separate model-only session
 *    refreshes settings that depend on that model. The explicit user effort is
 *    not applied, so reasoning.currentValue remains the provider's default for
 *    that model rather than echoing the saved Cuppet override.
 */
export async function discoverAcpRuntimeCatalog(providerID, options = {}) {
  const id = text(providerID).toLowerCase();
  const descriptor = localCliDescriptor(id);
  if (!descriptor || descriptor.transport !== 'acp') throw new Error(`Unsupported ACP provider: ${providerID ?? 'unknown'}`);
  const configuration = record(options.configuration);
  const cwd = text(options.cwd) || tmpdir();
  const baselineConfiguration = withoutRuntimeSelections(configuration);
  const baselineCapabilities = await discoverCapabilities(descriptor, baselineConfiguration, cwd);
  const baseline = catalogFromAcpCapabilities(id, baselineCapabilities);
  const defaultModel = exactAdvertisedModel(baseline.currentModel, baseline.models);
  const configuredModel = text(record(configuration.primary).modelID || configuration.model || configuration.modelID);

  let selected = baseline;
  if (configuredModel && configuredModel !== 'cli-default') {
    const modelConfiguration = withModelSelection(baselineConfiguration, configuredModel);
    const selectedCapabilities = await discoverCapabilities(descriptor, modelConfiguration, cwd);
    selected = catalogFromAcpCapabilities(id, selectedCapabilities);
  }

  return {
    ...baseline,
    currentModel: exactAdvertisedModel(selected.currentModel, baseline.models) || selected.currentModel || null,
    defaultModel,
    configId: selected.configId || baseline.configId || null,
    configOptions: selected.configOptions,
    ...(selected.reasoning ? { reasoning: selected.reasoning } : {}),
  };
}

export function catalogFromAcpCapabilities(providerID, capabilities = {}) {
  const source = record(capabilities);
  const models = (Array.isArray(source.models) ? source.models : []).flatMap((raw) => {
    const item = record(raw);
    const id = text(item.id);
    if (!id) return [];
    return [{
      id,
      label: text(item.label) || id,
      ...(text(item.description) ? { description: text(item.description) } : {}),
    }];
  });
  const modelSetting = modelRuntimeSetting(source);
  const currentModel = text(modelSetting?.value);
  const reasoningSetting = reasoningRuntimeSetting(source);
  const reasoning = reasoningSetting?.kind === 'select' && Array.isArray(reasoningSetting.options) && reasoningSetting.options.length
    ? {
        configId: reasoningSetting.id,
        currentValue: text(reasoningSetting.value) || null,
        options: reasoningSetting.options.map((item) => ({
          id: item.id,
          label: item.label || item.id,
          ...(item.description ? { description: item.description } : {}),
        })),
      }
    : null;
  return {
    providerID: text(providerID).toLowerCase(),
    available: models.length > 0,
    source: 'acp',
    models,
    currentModel: currentModel || null,
    // A capability snapshot only tells us the current value. It is a provider
    // default only when the caller knows the session was opened without an
    // override; discoverAcpRuntimeCatalog owns that distinction.
    defaultModel: null,
    configId: modelSetting?.id || null,
    configOptions: Array.isArray(source.settings) ? source.settings : [],
    ...(reasoning ? { reasoning } : {}),
  };
}

async function discoverCapabilities(descriptor, configuration, projectRoot) {
  const runtime = new AcpSessionRuntime({ descriptor, configuration, projectRoot });
  try {
    await runtime.start();
    return await runtime.capabilities();
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

function withoutRuntimeSelections(configuration) {
  const source = { ...record(configuration) };
  delete source.model;
  delete source.modelID;
  delete source.primaryEffort;
  delete source.effort;
  const primary = { ...record(source.primary) };
  delete primary.modelID;
  delete primary.model;
  delete primary.variant;
  source.primary = primary;
  return source;
}

function withModelSelection(configuration, modelID) {
  const source = { ...record(configuration) };
  source.model = modelID;
  source.primary = { ...record(source.primary), modelID };
  return source;
}

function exactAdvertisedModel(value, models) {
  const id = text(value);
  return id && Array.isArray(models) && models.some((item) => item.id === id) ? id : null;
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
