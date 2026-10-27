import JSON5 from 'json5';
import { opendirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerProjectAccessError } from './provider-failure.mjs';
import { parseSemanticVersion } from './version-policy.mjs';
import { verifyLocalProviderExecutableVersion } from './local-provider-version-check.mjs';

export function assertOpenCodeProjectAccess(projectRoot) {
  if (process.platform !== 'darwin') return;
  const protectedDirectory = ['Documents', 'Downloads', 'Desktop'].map(name => join(homedir(), name))
    .find(directory => projectRoot === directory || projectRoot.startsWith(`${directory}/`));
  if (!protectedDirectory) return;
  // OpenCode discovers configuration through parent directories, even when an
  // Open panel granted Cuppet access to only the selected project.
  try {
    realpathSync(protectedDirectory);
    // Metadata resolution alone can succeed while macOS still denies directory access.
    const directory = opendirSync(protectedDirectory);
    directory.closeSync();
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
    throw providerProjectAccessError('OpenCode', projectRoot, `${error.code}: ${protectedDirectory}`, error);
  }
}

export async function prepareOpenCodeAcpEnvironment(environment, configuration, command) {
  const compatibility = await verifyLocalProviderExecutableVersion({ id: 'opencode', label: 'OpenCode', versionArgs: ['--version'] }, {
    ...configuration, cliCommand: command, cliEnv: environment,
  });
  return openCodeMcpEnvironment(environment, compatibility.observedVersion);
}

export function openCodeMcpEnvironment(environment, version) {
  if ((parseSemanticVersion(version)?.parts[0] ?? 0) < 2) return environment;
  const config = environment.OPENCODE_CONFIG_CONTENT ? JSON5.parse(environment.OPENCODE_CONFIG_CONTENT) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenCode inline configuration must be an object.');
  const mcp = config.mcp ?? {};
  const servers = mcp.servers ?? {};
  // Cuppet supplies browser tools through its own MCP bridge. Prevent each
  // private OpenCode server from launching the same global browserControl port.
  const browserControl = servers.browserControl ?? { type: 'local', command: [process.execPath] };
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      mcp: { ...mcp, servers: { ...servers, browserControl: { ...browserControl, disabled: true } } },
    }),
  };
}
