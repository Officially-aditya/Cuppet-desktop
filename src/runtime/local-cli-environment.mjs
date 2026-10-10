import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix as posixPath, win32 as win32Path } from 'node:path';

const DARWIN_PATH_PROBE_TIMEOUT_MS = 3_000;
const DARWIN_PATH_MARKER = '__CUPPET_LOGIN_SHELL_PATH__=';
let cachedDarwinLoginPath = null;
let cachedDarwinLoginPathKey = '';

export function getEnv(env, ...keys) {
  if (!env || typeof env !== 'object') return '';
  for (const key of keys) {
    if (typeof env[key] === 'string' && env[key]) return env[key];
    const lowerKey = key.toLowerCase();
    for (const actualKey of Object.keys(env)) {
      if (actualKey.toLowerCase() === lowerKey && typeof env[actualKey] === 'string' && env[actualKey]) {
        return env[actualKey];
      }
    }
  }
  return '';
}

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
  const pathValue = getEnv(environment, 'PATH', 'Path');
  const existing = splitPath(pathValue, pathDelimiter);
  const explicit = splitPath(getEnv(environment, 'CUPPET_CLI_PATH'), pathDelimiter);
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
  if (merged.length) {
    environment.PATH = merged.join(pathDelimiter);
    if (platform === 'win32') environment.Path = environment.PATH;
  }
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
  const pathValue = getEnv(environment, 'PATH', 'Path');
  const pathEntries = splitPath(pathValue, pathDelimiter);
  const extensions = platform === 'win32'
    ? executableExtensions(getEnv(environment, 'PATHEXT', 'Pathext'))
    : [''];

  for (const directory of pathEntries) {
    const pathJoin = process.platform === 'win32'
      ? win32Path.join
      : (directory.startsWith('/') ? join : win32Path.join);
    for (const extension of extensions) {
      const fileName = platform === 'win32' && !value.toLowerCase().endsWith(extension.toLowerCase())
        ? `${value}${extension}`
        : (platform === 'win32' ? value : `${value}${extension}`);
      const candidate = pathJoin(directory, fileName);
      try {
        accessSync(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
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
  if (process.platform === 'win32' && environment.Path) process.env.Path = environment.Path;
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
  const isWin = platform === 'win32';
  const pathJoin = isWin ? win32Path.join : join;
  const pnpmHome = getEnv(environment, 'PNPM_HOME');
  const bunInstall = getEnv(environment, 'BUN_INSTALL');
  const appData = getEnv(environment, 'APPDATA', 'AppData') || (isWin && home ? pathJoin(home, 'AppData', 'Roaming') : '');
  const localAppData = getEnv(environment, 'LOCALAPPDATA', 'LocalAppData') || (isWin && home ? pathJoin(home, 'AppData', 'Local') : '');

  const candidates = [
    pnpmHome,
    getEnv(environment, 'GROK_BIN_DIR'),
    bunInstall ? pathJoin(bunInstall, 'bin') : '',
    appData ? pathJoin(appData, 'npm') : '',
    localAppData ? pathJoin(localAppData, 'agy', 'bin') : '',
    home ? pathJoin(home, '.local', 'bin') : '',
    home ? pathJoin(home, '.opencode', 'bin') : '',
    home ? pathJoin(home, '.grok', 'bin') : '',
    home ? pathJoin(home, '.kiro', 'bin') : '',
    home ? pathJoin(home, '.vibe', 'bin') : '',
    home ? pathJoin(home, '.copilot', 'bin') : '',
    home ? pathJoin(home, '.bun', 'bin') : '',
    home ? pathJoin(home, '.npm-global', 'bin') : '',
  ];
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  } else if (isWin) {
    const systemRoot = getEnv(environment, 'SystemRoot', 'windir') || 'C:\\Windows';
    const programFiles = getEnv(environment, 'ProgramFiles') || 'C:\\Program Files';
    const programFilesX86 = getEnv(environment, 'ProgramFiles(x86)') || 'C:\\Program Files (x86)';
    candidates.push(
      pathJoin(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      pathJoin(systemRoot, 'System32'),
      systemRoot,
      pathJoin(systemRoot, 'System32', 'OpenSSH'),
      pathJoin(programFiles, 'PowerShell', '7'),
      pathJoin(programFiles, 'Git', 'cmd'),
      pathJoin(programFiles, 'Git', 'bin'),
      localAppData ? pathJoin(localAppData, 'Programs', 'Git', 'cmd') : '',
      localAppData ? pathJoin(localAppData, 'Programs', 'Git', 'bin') : '',
      localAppData ? pathJoin(localAppData, 'Microsoft', 'WinGet', 'Links') : '',
      pathJoin(programFiles, 'WinGet', 'Links'),
      localAppData ? pathJoin(localAppData, 'Microsoft', 'WindowsApps') : '',
      pathJoin(programFiles, 'Kiro-Cli'),
      home ? pathJoin(home, 'scoop', 'shims') : '',
      pathJoin(programFiles, 'nodejs'),
      pathJoin(programFilesX86, 'nodejs'),
    );
  }
  return candidates.filter((value) => typeof value === 'string' && value.trim());
}

/** App presence is discovery evidence, not proof of an authenticated ACP runtime. */
export function detectLocalProviderApp(providerID, inherited = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || homedir();
  const check = options.accessSyncImpl || accessSync;
  const copilot = providerID === 'github-copilot';
  if (!copilot && providerID !== 'antigravity') return null;
  const product = copilot ? 'Microsoft VS Code' : 'Antigravity';
  const label = copilot ? 'Visual Studio Code' : 'Google Antigravity';
  let candidates = [];
  if (platform === 'win32') {
    const local = getEnv(inherited, 'LOCALAPPDATA') || win32Path.join(home, 'AppData', 'Local');
    const system = getEnv(inherited, 'ProgramFiles') || 'C:\\Program Files';
    candidates = [win32Path.join(local, 'Programs', product), win32Path.join(system, product)];
  } else if (platform === 'darwin') {
    const bundle = copilot ? 'Visual Studio Code.app' : 'Antigravity.app';
    candidates = [join('/Applications', bundle), join(home, 'Applications', bundle)];
  } else if (platform === 'linux') {
    candidates = [copilot ? '/usr/share/code' : '/usr/share/antigravity', copilot ? '/opt/visual-studio-code' : '/opt/Antigravity'];
  }
  for (const path of candidates) {
    const executable = platform === 'win32'
      ? win32Path.join(path, copilot ? 'Code.exe' : 'Antigravity.exe')
      : platform === 'darwin' ? join(path, 'Contents', 'MacOS', 'Electron') : join(path, copilot ? 'code' : 'antigravity');
    try { check(executable, fsConstants.F_OK); return { label, path }; } catch {}
  }
  return null;
}

/** Resolve PowerShell executable on Windows, checking canonical system paths before bare fallback. */
export function resolveWindowsPowerShell(platform = process.platform, env = process.env, accessSyncImpl = accessSync) {
  if (platform !== 'win32') return 'powershell.exe';
  const systemRoot = getEnv(env, 'SystemRoot', 'windir') || 'C:\\Windows';
  const programFiles = getEnv(env, 'ProgramFiles') || 'C:\\Program Files';
  const candidates = [
    win32Path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    win32Path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    win32Path.join(systemRoot, 'powershell.exe'),
  ];
  for (const candidate of candidates) {
    try {
      accessSyncImpl(candidate, fsConstants.F_OK);
      return candidate;
    } catch {}
  }
  return 'powershell.exe';
}

function executableExtensions(value) {
  const extensions = String(value || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...extensions.filter((item) => item.startsWith('.')), ''];
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
