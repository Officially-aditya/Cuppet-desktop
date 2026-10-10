import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../../../local-cli-descriptors.mjs';
import { modelRuntimeSetting, reasoningRuntimeSetting } from '../../capabilities.mjs';
import { AcpSessionRuntime } from './acp-session.mjs';
import { verifyLocalProviderExecutableVersion } from '../../local-provider-version-check.mjs';
import { providerFailureMetadata } from '../../provider-failure.mjs';
import { clearProviderRuntimeFailure, recordProviderRuntimeFailure } from '../../runtime-health-registry.mjs';

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
 *
 * Managed ACP providers may pass a runtime descriptor explicitly. This keeps
 * installation/spawn policy in the backend while the ACP discovery algorithm
 * remains provider-agnostic.
 */
export async function discoverAcpRuntimeCatalog(providerID, options = {}) {
  const id = text(providerID).toLowerCase();
  const descriptor = options.descriptor ?? localCliDescriptor(id);
  if (!descriptor || descriptor.transport !== 'acp') throw new Error(`Unsupported ACP provider: ${providerID ?? 'unknown'}`);
  const configuration = record(options.configuration);
  await verifyLocalProviderExecutableVersion(descriptor, configuration);
  const cwd = text(options.cwd) || tmpdir();
  const baselineConfiguration = withoutRuntimeSelections(configuration);
  const runtime = new AcpSessionRuntime({ descriptor, configuration: baselineConfiguration, projectRoot: cwd });
  try {
    await runtime.start();
    clearProviderRuntimeFailure(id);
    const baseline = catalogFromAcpCapabilities(id, await runtime.capabilities());
    const defaultModel = exactAdvertisedModel(baseline.currentModel, baseline.models);
    const configuredModel = text(record(configuration.primary).modelID || configuration.model || configuration.modelID);

    let selected = baseline;
    if (exactAdvertisedModel(configuredModel, baseline.models)) {
      await runtime.newSession({ selection: { model: configuredModel } });
      selected = catalogFromAcpCapabilities(id, await runtime.capabilities());
    }

    return {
      ...baseline,
      currentModel: exactAdvertisedModel(selected.currentModel, baseline.models) || selected.currentModel || null,
      defaultModel,
      configId: selected.configId || baseline.configId || null,
      configOptions: selected.configOptions,
      ...(selected.reasoning ? { reasoning: selected.reasoning } : {}),
    };
  } catch (error) {
    const failure = providerFailureMetadata(error);
    if (failure?.category === 'authentication') recordProviderRuntimeFailure(id, {
      code: error.code, category: failure.category, retryable: false, at: Date.now(),
    });
    throw error;
  } finally {
    await runtime.close().catch(() => undefined);
  }
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

function exactAdvertisedModel(value, models) {
  const id = text(value);
  return id && Array.isArray(models) && models.some((item) => item.id === id) ? id : null;
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
