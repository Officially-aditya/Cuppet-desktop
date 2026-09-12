import { tmpdir } from 'node:os';
import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { discoverAcpRuntimeCatalog } from '../transports/acp/acp-discovery.mjs';
import { AcpProviderAdapter } from './acp.mjs';
import { resolveAntigravityAcpInstallation } from './antigravity-install.mjs';

export function antigravityBackendDefinition() {
  const provider = localCliDescriptor('antigravity');
  return {
    id: provider.id,
    label: provider.label,
    transport: provider.transport,
    operations: {
      discoverCapabilities: async ({ configuration = {}, options = {} } = {}) => {
        const install = typeof options.resolveInstallation === 'function'
          ? options.resolveInstallation
          : resolveAntigravityAcpInstallation;
        const installation = await install(configuration, options.installOptions ?? {});
        const descriptor = antigravityAcpDescriptor(installation);
        const runtimeConfiguration = antigravityRuntimeConfiguration(configuration, installation);
        const discover = typeof options.acpDiscover === 'function' ? options.acpDiscover : discoverAcpRuntimeCatalog;
        const catalog = await discover(provider.id, {
          configuration: runtimeConfiguration,
          descriptor,
          cwd: text(options.cwd) || tmpdir(),
        });
        return {
          providerID: provider.id,
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
    createRuntime: ({ configuration = {} } = {}) => new ManagedAntigravityProvider(configuration),
  };
}

export class ManagedAntigravityProvider {
  #configuration;
  #resolveInstallation;

  constructor(configuration = {}, { resolveInstallation = resolveAntigravityAcpInstallation } = {}) {
    this.#configuration = { ...configuration };
    this.#resolveInstallation = resolveInstallation;
  }

  async stream(messages, options = {}) {
    const installation = await this.#resolveInstallation(this.#configuration, this.#configuration.installOptions ?? {});
    const descriptor = antigravityAcpDescriptor(installation);
    const configuration = antigravityRuntimeConfiguration(this.#configuration, installation);
    const provider = new AcpProviderAdapter(configuration, { descriptor });
    return provider.stream(messages, options);
  }
}

export function antigravityAcpDescriptor(installation) {
  const command = requiredText(installation?.command, 'Antigravity ACP command');
  const harnessPath = requiredText(installation?.harnessPath, 'Antigravity harness path');
  const args = Array.isArray(installation?.args) ? installation.args.map(String) : [];
  return {
    id: 'antigravity',
    label: 'Google Antigravity',
    transport: 'acp',
    command,
    args,
    versionArgs: [],
    envOverride: 'CUPPET_ANTIGRAVITY_ACP_BIN',
    loginHint: 'Complete Google Antigravity sign-in in the browser, then retry.',
    authentication: { methods: [{ id: 'oauth-personal' }] },
    environment: (inherited = {}) => antigravityEnvironment(inherited, harnessPath),
  };
}

function antigravityRuntimeConfiguration(configuration, installation) {
  const source = { ...record(configuration) };
  source.cliCommand = requiredText(installation?.command, 'Antigravity ACP command');
  source.cliArgs = Array.isArray(installation?.args) ? installation.args.map(String) : [];
  delete source.antigravityAcpCommand;
  delete source.antigravityAcpArgs;
  delete source.antigravityHarnessPath;
  delete source.installOptions;
  return source;
}

function antigravityEnvironment(inherited, harnessPath) {
  const environment = { ...inherited };
  // The desktop provider currently represents Google-account Antigravity.
  // Prevent unrelated Gemini/Vertex environment credentials from silently
  // changing the auth mode underneath the oauth-personal ACP session.
  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GCLOUD_PROJECT',
    'CLOUDSDK_CORE_PROJECT',
    'AGY_ACP_CCPA_PROJECT',
    'AGY_ACP_ENABLE_OAUTH',
    'ANTIGRAVITY_HARNESS_PATH',
    'ELECTRON_RUN_AS_NODE',
  ]) delete environment[key];
  environment.ANTIGRAVITY_HARNESS_PATH = harnessPath;
  environment.AGY_ACP_FORCE_FILE_STORAGE = '1';
  environment.PYTHONUNBUFFERED = '1';
  return environment;
}

function requiredText(value, label) {
  const result = text(value);
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
