import { OpenAICompatibleChatProvider } from '../provider.mjs';
import { createNativeProvider, nativeProviderKind } from '../native-provider.mjs';
import { localCliDescriptor, localCliProviderIDs } from '../local-cli-descriptors.mjs';
import { discoverAcpRuntimeCatalog } from './transports/acp/acp-discovery.mjs';
import { AcpProviderAdapter } from './backends/acp.mjs';
import { antigravityBackendDefinition } from './backends/antigravity.mjs';
import { codexBackendDefinition } from './backends/codex.mjs';
import { opencodeBackendDefinition } from './backends/opencode.mjs';
import { discoverApiCapabilities } from './backends/api.mjs';
import { ProviderBackendRegistry } from './backend-registry.mjs';
import { ProviderCapabilitySnapshotStore } from './capability-snapshot.mjs';

export const providerBackendRegistry = buildProviderBackendRegistry();
export const providerCapabilitySnapshots = new ProviderCapabilitySnapshotStore();

export function buildProviderBackendRegistry() {
  const registry = new ProviderBackendRegistry();
  registry.register(codexBackendDefinition());
  registry.register(opencodeBackendDefinition());
  registry.register(antigravityBackendDefinition());

  for (const id of localCliProviderIDs()) {
    if (id === 'opencode' || id === 'antigravity') continue;
    const descriptor = localCliDescriptor(id);
    if (!descriptor) continue;
    registry.register({
      id: descriptor.id,
      label: descriptor.label,
      transport: descriptor.transport,
      operations: {
        discoverCapabilities: async ({ configuration = {}, options = {} } = {}) => {
          if (descriptor.transport !== 'acp') {
            return { providerID: descriptor.id, source: descriptor.transport, available: false, models: [], settings: [], defaultModel: null, currentModel: null };
          }
          const discover = typeof options.acpDiscover === 'function' ? options.acpDiscover : discoverAcpRuntimeCatalog;
          const catalog = await discover(descriptor.id, { configuration });
          return {
            providerID: descriptor.id,
            source: 'acp',
            available: catalog.available !== false && Array.isArray(catalog.models) && catalog.models.length > 0,
            models: Array.isArray(catalog.models) ? catalog.models : [],
            settings: Array.isArray(catalog.configOptions) ? catalog.configOptions : [],
            defaultModel: text(catalog.defaultModel) || null,
            currentModel: text(catalog.currentModel) || null,
            modelDependentSettings: true,
            ...(catalog.reasoning ? { reasoning: catalog.reasoning } : {}),
          };
        },
      },
      // ACP is a shared protocol runtime. Provider-specific policy lives in
      // descriptors/support shims; provider-specific transports live in their
      // own backend definitions instead of being forced through ACP.
      createRuntime: ({ configuration = {} } = {}) => new AcpProviderAdapter(configuration, { descriptor }),
    });
  }

  // Native API implementations are selected before the generic OpenAI-compatible
  // fallback, but both expose the same registry contract to callers.
  registry.register({
    id: 'native-api',
    label: 'Native API',
    transport: 'http',
    matches: (configuration) => Boolean(nativeProviderKind(configuredProviderId(configuration))),
    operations: { discoverCapabilities: discoverApiCapabilities },
    createRuntime: ({ configuration = {} } = {}) => {
      const kind = nativeProviderKind(configuredProviderId(configuration));
      const sourceFetch = configuration?.fetchImpl ?? globalThis.fetch;
      const prepared = typeof sourceFetch === 'function' && kind
        ? { ...configuration, fetchImpl: nativeFetchGuard(kind, sourceFetch) }
        : configuration;
      return createNativeProvider(prepared);
    },
  });

  registry.register({
    id: 'openai-compatible',
    label: 'OpenAI-compatible API',
    transport: 'http',
    matches: () => true,
    operations: { discoverCapabilities: discoverApiCapabilities },
    createRuntime: ({ configuration = {} } = {}) => new OpenAICompatibleChatProvider(configuration),
  });

  return registry;
}

export function resolveProviderBackend(configuration = {}) {
  return providerBackendRegistry.requireResolved(configuration);
}

export function createProviderRuntime(configuration = {}, context = {}) {
  return providerBackendRegistry.createConfiguredRuntime(configuration, context);
}

export function discoverProviderCapabilitySnapshot(configuration = {}, options = {}) {
  return providerCapabilitySnapshots.refresh(providerBackendRegistry, configuration, options);
}

function configuredProviderId(configuration) {
  const source = record(configuration);
  return text(source.providerID || record(source.primary).providerID).toLowerCase();
}

function nativeFetchGuard(kind, inner) {
  return async (url, init = {}) => {
    let nextUrl = String(url);
    let nextInit = init;

    if (kind === 'vertex-gemini') {
      try {
        const parsed = new URL(nextUrl);
        const key = parsed.searchParams.get('key');
        if (key) {
          parsed.searchParams.delete('key');
          nextUrl = parsed.toString();
          nextInit = { ...init, headers: { ...(init.headers ?? {}), 'x-goog-api-key': key } };
        }
      } catch {}
    }

    if (kind === 'gemini-interactions' && typeof nextInit.body === 'string') {
      try {
        const body = JSON.parse(nextInit.body);
        if (Array.isArray(body?.input)) {
          body.input = body.input.map((item) => item?.type === 'function_result' && Array.isArray(item.result)
            ? { ...item, result: { content: item.result } }
            : item);
          nextInit = { ...nextInit, body: JSON.stringify(body) };
        }
      } catch {}
    }

    return inner(nextUrl, nextInit);
  };
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export { nativeProviderKind };
