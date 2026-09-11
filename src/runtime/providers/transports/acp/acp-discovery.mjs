import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../../../local-cli-descriptors.mjs';
import { modelRuntimeSetting, reasoningRuntimeSetting } from '../../capabilities.mjs';
import { AcpSessionRuntime } from './acp-session.mjs';

/**
 * Discover provider-authoritative ACP model/config metadata through the same
 * runtime and capability parser used for actual turns.
 */
export async function discoverAcpRuntimeCatalog(providerID, options = {}) {
  const id = text(providerID).toLowerCase();
  const descriptor = localCliDescriptor(id);
  if (!descriptor || descriptor.transport !== 'acp') throw new Error(`Unsupported ACP provider: ${providerID ?? 'unknown'}`);
  const configuration = record(options.configuration);
  const runtime = new AcpSessionRuntime({
    descriptor,
    configuration,
    projectRoot: text(options.cwd) || tmpdir(),
  });
  try {
    await runtime.start();
    const capabilities = await runtime.capabilities();
    return catalogFromAcpCapabilities(id, capabilities);
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
    defaultModel: currentModel || null,
    configId: modelSetting?.id || null,
    configOptions: Array.isArray(source.settings) ? source.settings : [],
    ...(reasoning ? { reasoning } : {}),
  };
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
