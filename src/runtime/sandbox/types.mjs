/**
 * Native Sandbox Subsystem Types and Constants.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * @typedef {Object} SandboxPolicy
 * @property {string} projectRoot - Absolute path to the active project workspace
 * @property {string[]} [scratchDirs] - Additional scratch/temp directories allowed for read/write
 * @property {boolean} [offline=false] - Whether outbound network sockets should be blocked
 * @property {boolean} [protectSensitiveCredentials=true] - Whether sensitive host credential paths (~/.ssh, ~/.aws) are blocked
 * @property {Record<string, string>} [envOverrides] - Explicit environment variables to provide to the sandbox
 */

/**
 * @typedef {Object} SandboxRunSpec
 * @property {string} command - Shell command string to execute
 * @property {string} cwd - Current working directory (must be inside projectRoot or scratchDirs)
 * @property {number} [timeoutMs=30000] - Command timeout in milliseconds
 * @property {AbortSignal} [signal] - AbortSignal for early termination
 * @property {SandboxPolicy} policy - Active sandbox policy
 */

/**
 * @typedef {Object} SandboxExecutionResult
 * @property {number} code - Process exit code
 * @property {string} stdout - Captured standard output
 * @property {string} stderr - Captured standard error
 * @property {string} driverName - Name of the driver that executed the command ('mac-seatbelt' | 'linux-bwrap' | 'host-fallback')
 */

export const PROVIDER_CREDENTIAL_PATHS = [
  '.codex/auth.json',
  '.claude.json',
  '.claude/.credentials.json',
  '.grok/auth.json',
  '.vibe/.env',
  '.local/share/opencode/auth.json',
  '.config/opencode/auth.json',
  '.gemini/oauth_creds.json',
  '.gemini/.env',
];

export const SENSITIVE_HOST_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.azure',
  '.kube',
  '.netrc',
  '.dockercfg',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
  'Library/Keychains',
  '.bash_history',
  '.zsh_history',
  '.history',
  '.git-credentials',
  '.gitconfig',
  '.config/git',
  '.config/gh',
  '.config/hub',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  ...PROVIDER_CREDENTIAL_PATHS,
];

export function providerCredentialPaths(environment = process.env, userHome = homedir(), projectRoot = process.cwd()) {
  const paths = PROVIDER_CREDENTIAL_PATHS.map((path) => join(userHome, path));
  for (const [variable, files] of [
    ['CODEX_HOME', ['auth.json']],
    ['CLAUDE_CONFIG_DIR', ['.credentials.json']],
    ['GROK_HOME', ['auth.json']],
    ['VIBE_HOME', ['.env']],
    ['GEMINI_HOME', ['oauth_creds.json', '.env']],
    ['OPENCODE_CONFIG_DIR', ['auth.json']],
    ['XDG_DATA_HOME', ['opencode/auth.json']],
    ['XDG_CONFIG_HOME', ['opencode/auth.json']],
  ]) {
    const directory = environment[variable];
    if (typeof directory === 'string' && directory) {
      paths.push(...files.map((file) => resolve(projectRoot, directory, file)));
    }
  }
  for (const variable of ['GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE']) {
    const path = environment[variable];
    if (typeof path === 'string' && path) paths.push(resolve(projectRoot, path));
  }
  if (typeof environment.CUPPET_USER_DATA_DIR === 'string' && environment.CUPPET_USER_DATA_DIR) paths.push(resolve(projectRoot, environment.CUPPET_USER_DATA_DIR, 'provider-settings.json'));
  return [...new Set(paths)];
}

export function sensitiveHostPaths(environment = process.env, userHome = homedir(), projectRoot = process.cwd()) {
  return [...new Set([...SENSITIVE_HOST_PATHS.map((path) => join(userHome, path)), ...providerCredentialPaths(environment, userHome, projectRoot)])];
}
