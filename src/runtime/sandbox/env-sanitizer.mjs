/**
 * Environment Sanitizer for Cuppet Desktop Sandbox.
 *
 * Strips cloud API keys, SSH credentials, tokens, and sensitive authorization headers
 * before commands are executed by the autonomous coding agent.
 */

const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_COLLATE',
  'LC_NUMERIC',
  'LC_TIME',
  'TMPDIR',
  'NODE_ENV',
  'CI',
  'PWD',
  'EDITOR',
  'VISUAL',
  // Standard toolchain directory pointers (non-credential)
  'NVM_DIR',
  'PYENV_ROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
  'CONDA_PREFIX',
  'VIRTUAL_ENV',
]);

const SENSITIVE_KEY_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|CERT|PRIVATE|SIGNATURE)/i;

const SENSITIVE_PREFIX_PATTERN = /^(?:AWS_|GITHUB_|GH_|OPENAI_|ANTHROPIC_|GEMINI_|AZURE_|GOOGLE_|CUPPET_|STRIPE_|SSH_|SLACK_|DISCORD_|DATABASE_|DB_|POSTGRES_|MYSQL_|MONGO_|CLOUDFLARE_)/i;

/**
 * Sanitizes an environment object for safe sandbox process execution.
 *
 * @param {Record<string, string | undefined>} [sourceEnv=process.env]
 * @param {Record<string, string>} [overrides={}]
 * @returns {Record<string, string>}
 */
export function sanitizeEnvironment(sourceEnv = process.env, overrides = {}) {
  const sanitized = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined || value === null) continue;

    // Check against safe allowlist
    const isAllowlisted = SAFE_ENV_ALLOWLIST.has(key);

    // If not in allowlist, ignore it
    if (!isAllowlisted) continue;

    // Even if allowlisted, verify it doesn't match a sensitive pattern
    if (SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_PREFIX_PATTERN.test(key)) continue;

    sanitized[key] = String(value);
  }

  // Ensure PATH and HOME are present
  if (!sanitized.PATH && sourceEnv.PATH) sanitized.PATH = sourceEnv.PATH;
  if (!sanitized.HOME && sourceEnv.HOME) sanitized.HOME = sourceEnv.HOME;
  if (!sanitized.TMPDIR) sanitized.TMPDIR = sourceEnv.TMPDIR || '/tmp';

  // Apply explicit overrides if provided
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof key === 'string' && value !== undefined && value !== null) {
        sanitized[key] = String(value);
      }
    }
  }

  return sanitized;
}
