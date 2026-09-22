/**
 * Native Sandbox Subsystem Types and Constants.
 */

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
];
