import { createHash } from 'node:crypto';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { discoverAcpRuntimeCatalog } from '../transports/acp/acp-discovery.mjs';
import { AcpProviderAdapter } from './acp.mjs';
import { providerFailureError } from '../provider-failure.mjs';
import { resolveAntigravityAcpInstallation } from './antigravity-install.mjs';
import { deleteAntigravitySessions } from '../session-cleanup.mjs';

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
        const installation = await install(configuration, { ...options.installOptions, allowInstall: false });
        if (!installation) throw new Error('Connect Google Antigravity in Settings to install its missing ACP runtime.');
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
  #adapter;

  constructor(configuration = {}, { resolveInstallation = resolveAntigravityAcpInstallation } = {}) {
    this.#adapter = new AcpProviderAdapter(configuration, {
      descriptor: antigravityAcpDescriptor(null, { resolveInstallation }),
    });
  }

  cuppetManagedRuntime() { return this.#adapter.cuppetManagedRuntime(); }
  stream(messages, options = {}) { return this.#adapter.stream(messages, options); }
}

export async function antigravityWorkerConfiguration(configuration, dataDir) {
  if (text(configuration?.providerID).toLowerCase() !== 'antigravity') return configuration;
  const configuredHome = text(configuration?.cliEnv?.GEMINI_HOME) || text(process.env.GEMINI_HOME) || join(homedir(), '.gemini');
  const providerHome = /^~[\\/]/.test(configuredHome) ? join(homedir(), configuredHome.slice(2)) : configuredHome;
  const authDirectory = await realpath(join(providerHome, 'antigravity-acp')).catch(() => { throw new Error('Connect Antigravity before starting subagents.'); });
  const identity = createHash('sha256').update(authDirectory).digest('hex').slice(0, 20);
  const workerHome = join(dataDir, 'antigravity-workers', identity);
  const authLink = join(workerHome, 'antigravity-acp');
  await mkdir(workerHome, { recursive: true, mode: 0o700 });
  try { await symlink(authDirectory, authLink, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error?.code !== 'EEXIST' || await realpath(authLink).catch(() => '') !== authDirectory) throw new Error('Could not prepare the Antigravity subagent profile.');
  }
  // Keep provider-owned authentication and session cleanup, but do not start
  // the user's global MCP servers once per concurrent worker. Cuppet supplies
  // the active turn's tools through its session-scoped MCP bridge.
  return { ...configuration, cliEnv: { ...record(configuration?.cliEnv), GEMINI_HOME: workerHome } };
}

export function antigravityAcpDescriptor(installation, { resolveInstallation = resolveAntigravityAcpInstallation } = {}) {
  const command = installation ? requiredText(installation.command, 'Antigravity ACP command') : 'agy_acp_server';
  const harnessPath = installation ? requiredText(installation.harnessPath, 'Antigravity harness path') : '';
  const args = Array.isArray(installation?.args) ? installation.args.map(String) : [];
  const authenticationUrls = new Set();
  return {
    id: 'antigravity',
    label: 'Google Antigravity',
    transport: 'acp',
    command,
    args,
    versionArgs: [],
    envOverride: installation ? 'CUPPET_ANTIGRAVITY_ACP_BIN' : '',
    loginHint: 'Complete Google Antigravity sign-in in the browser, then retry.',
    authentication: { methods: [{ id: 'oauth-personal' }], onSessionRequired: true, allowCached: true },
    cleanupSessions: deleteAntigravitySessions,
    cleanupRequiresProcessExit: true,
    environment: (inherited = {}) => antigravityEnvironment(inherited, harnessPath),
    diagnosticError: (line, configuration) => {
      const text = String(line || '').trim();
      // Credential/tier diagnostics contain Google URLs too; only the native
      // browser-login prompt is evidence that interactive authentication is needed.
      if (!text.includes('Open the following link to authenticate the ACP server:')) return null;
      if (configuration?.allowInteractiveAuth === true) {
        const candidate = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/)?.[0];
        if (candidate && !authenticationUrls.has(candidate) && typeof configuration.onAuthenticationUrl === 'function') {
          const url = new URL(candidate);
          if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') {
            authenticationUrls.add(candidate);
            configuration.onAuthenticationUrl(url.toString());
          }
        }
        return null;
      }
      return providerFailureError('Sign in to Google Antigravity in Settings before continuing.', {
        code: 'PROVIDER_AUTHENTICATION_REQUIRED', category: 'authentication', action: 'reauthenticate', providerID: 'antigravity',
      });
    },
    ...(!installation ? {
      resolveRuntime: async (configuration, { environment } = {}) => {
        const resolved = await resolveInstallation(configuration, { ...configuration.installOptions, allowInstall: false });
        if (!resolved) return null;
        return { ...resolved, env: antigravityEnvironment(environment ?? {}, requiredText(resolved.harnessPath, 'Antigravity harness path')) };
      },
    } : {}),
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
  if (harnessPath) environment.ANTIGRAVITY_HARNESS_PATH = harnessPath;
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
