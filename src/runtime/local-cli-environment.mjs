import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DARWIN_PATH_PROBE_TIMEOUT_MS = 3_000;
const DARWIN_PATH_MARKER = '__CUPPET_LOGIN_SHELL_PATH__=';
let cachedDarwinLoginPath = null;
let cachedDarwinLoginPathKey = '';

/**
 * Build the environment Cuppet should use when resolving user-installed CLIs.
 *
 * Finder/Dock-launched macOS apps inherit launchd's small PATH rather than the
 * PATH the user gets in an interactive Terminal. Recover only PATH from the
 * user's login shell; do not import arbitrary shell variables or credentials.
 */
export function localCliEnvironment(inherited = process.env, options = {}) {
  const environment = inherited && typeof inherited === 'object' ? { ...inherited } : {};
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const home = typeof options.home === 'string' ? options.home : homedir();
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const existing = splitPath(environment.PATH, pathDelimiter);
  const explicit = splitPath(environment.CUPPET_CLI_PATH, pathDelimiter);
  const recovered = platform === 'darwin'
    ? splitPath(recoverDarwinLoginPath(environment, options), pathDelimiter)
    : [];
  const candidates = fallbackCliPaths(environment, home, platform);

  const merged = dedupePath([
    ...explicit,
    ...recovered,
    ...existing,
    ...candidates,
  ]);
  if (merged.length) environment.PATH = merged.join(pathDelimiter);
  return environment;
}

/**
 * Resolve a bare provider command to the exact executable Cuppet will spawn.
 *
 * GUI apps should not rely on child_process repeating shell lookup semantics after
 * packaging. Resolve once from the recovered CLI environment and pass the absolute
 * path into the provider transport. Explicit absolute/custom paths are preserved.
 */
export function resolveLocalCliExecutable(command, inherited = process.env, options = {}) {
  const value = typeof command === 'string' ? command.trim() : '';
  if (!value || value.includes('\0')) return value;
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) return value;

  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const environment = options.environment && typeof options.environment === 'object'
    ? options.environment
    : localCliEnvironment(inherited, options);
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const pathEntries = splitPath(environment.PATH, pathDelimiter);
  const extensions = platform === 'win32'
    ? executableExtensions(environment.PATHEXT)
    : [''];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${value}${extension}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return value;
}

/** Apply the local-CLI PATH to the current process for main-process probes. */
export function applyLocalCliEnvironment(options = {}) {
  const environment = localCliEnvironment(process.env, options);
  if (environment.PATH) process.env.PATH = environment.PATH;
  return environment;
}

function recoverDarwinLoginPath(environment, options) {
  const injectedProbe = typeof options.loginPathProbe === 'function' ? options.loginPathProbe : null;
  if (injectedProbe) {
    try { return cleanPath(injectedProbe({ ...environment })); }
    catch { return ''; }
  }

  const shell = loginShell(environment.SHELL);
  const home = typeof environment.HOME === 'string' ? environment.HOME : '';
  const key = `${shell}\u0000${home}`;
  if (cachedDarwinLoginPath !== null && cachedDarwinLoginPathKey === key) return cachedDarwinLoginPath;

  let recovered = '';
  try {
    const result = spawnSync(shell, ['-l', '-i', '-c', `printf '${DARWIN_PATH_MARKER}%s\\n' "$PATH"`], {
      env: {
        ...environment,
        TERM: environment.TERM || 'dumb',
        CUPPET_SHELL_PATH_PROBE: '1',
      },
      encoding: 'utf8',
      timeout: DARWIN_PATH_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    recovered = markerPath(result?.stdout);
  } catch {
    recovered = '';
  }

  cachedDarwinLoginPathKey = key;
  cachedDarwinLoginPath = recovered;
  return recovered;
}

function loginShell(value) {
  const shell = typeof value === 'string' ? value.trim() : '';
  if (shell && isAbsolute(shell) && !shell.includes('\u0000')) return shell;
  return '/bin/zsh';
}

function markerPath(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const marker = line.indexOf(DARWIN_PATH_MARKER);
    if (marker < 0) continue;
    return cleanPath(line.slice(marker + DARWIN_PATH_MARKER.length));
  }
  return '';
}

function fallbackCliPaths(environment, home, platform) {
  const candidates = [
    environment.PNPM_HOME,
    environment.BUN_INSTALL ? join(environment.BUN_INSTALL, 'bin') : '',
    environment.APPDATA ? join(environment.APPDATA, 'npm') : '',
    environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, 'agy', 'bin') : '',
    home ? join(home, '.local', 'bin') : '',
    home ? join(home, '.opencode', 'bin') : '',
    home ? join(home, '.grok', 'bin') : '',
    home ? join(home, '.kiro', 'bin') : '',
    home ? join(home, '.vibe', 'bin') : '',
    home ? join(home, '.copilot', 'bin') : '',
    home ? join(home, '.bun', 'bin') : '',
    home ? join(home, '.npm-global', 'bin') : '',
  ];
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  return candidates.filter((value) => typeof value === 'string' && value.trim());
}

function executableExtensions(value) {
  const extensions = String(value || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  return ['', ...extensions.filter((item) => item.startsWith('.'))];
}

function splitPath(value, delimiter) {
  return String(value ?? '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}
function cleanPath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.includes('\u0000') || text.length > 64 * 1024) return '';
  return text;
}
function dedupePath(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const value = typeof entry === 'string' ? entry.trim() : '';
    if (!value || value.includes('\u0000') || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
