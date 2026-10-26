import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, posix as posixPath, win32 as win32Path } from 'node:path';

const SHELL_PROBE_TIMEOUT_MS = 5_000;
const SHELL_CACHE_MS = 30_000;
const ENV_MARKER = '__CUPPET_CLI_ENV_';
const SHELL_ENV_KEYS = ['PATH', '__MISE_DIFF', 'FNM_DIR', 'FNM_MULTISHELL_PATH'];
let cachedShellEnvironment = null;

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
 * Desktop apps may inherit a smaller PATH than an interactive terminal. Recover
 * PATH and the version-manager state needed to use it, never arbitrary secrets.
 */
export function localCliEnvironment(inherited = process.env, options = {}) {
  const environment = inherited && typeof inherited === 'object' ? { ...inherited } : {};
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;
  const home = typeof options.home === 'string' ? options.home : homedir();
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const pathValue = getEnv(environment, 'PATH', 'Path');
  const existing = splitPath(pathValue, pathDelimiter);
  const explicit = splitPath(getEnv(environment, 'CUPPET_CLI_PATH'), pathDelimiter);
  const npmPrefix = getEnv(environment, 'NPM_CONFIG_PREFIX', 'npm_config_prefix');
  const explicitNpm = npmPrefix ? [platform === 'win32' ? npmPrefix : posixPath.join(npmPrefix, 'bin')] : [];
  const shellEnvironment = recoverShellEnvironment(environment, { ...options, platform, home });
  const recovered = splitPath(shellEnvironment.PATH, pathDelimiter);
  for (const key of SHELL_ENV_KEYS.slice(1)) {
    if (shellEnvironment[key]) environment[key] = shellEnvironment[key];
  }
  const candidates = fallbackCliPaths(environment, home, platform);

  const merged = dedupePath([
    ...explicit,
    ...explicitNpm,
    ...recovered,
    ...existing,
    ...candidates,
  ]);
  if (merged.length) {
    if (platform === 'win32') {
      for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
    }
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
      : (directory.startsWith('/') ? posixPath.join : win32Path.join);
    for (const extension of extensions) {
      const fileName = platform === 'win32' && !value.toLowerCase().endsWith(extension.toLowerCase())
        ? `${value}${extension}`
        : (platform === 'win32' ? value : `${value}${extension}`);
      const candidate = pathJoin(directory, fileName);
      try {
        accessSync(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        if (platform === 'win32' && process.platform !== 'win32' && extension) {
          try {
            const lowerCandidate = pathJoin(directory, `${value}${extension.toLowerCase()}`);
            accessSync(lowerCandidate, fsConstants.F_OK);
            return lowerCandidate;
          } catch {}
        }
      }
    }
  }
  return value;
}

/** Apply the local-CLI PATH to the current process for main-process probes. */
export function applyLocalCliEnvironment(options = {}) {
  const environment = localCliEnvironment(process.env, options);
  for (const key of SHELL_ENV_KEYS) {
    if (environment[key]) process.env[key] = environment[key];
  }
  if (process.platform === 'win32' && environment.Path) process.env.Path = environment.Path;
  return environment;
}

function recoverShellEnvironment(environment, options) {
  const injectedProbe = typeof options.loginPathProbe === 'function' ? options.loginPathProbe : null;
  if (injectedProbe) {
    try { return { PATH: cleanPath(injectedProbe({ ...environment })) }; }
    catch { return {}; }
  }
  const { platform, home } = options;
  if (!['darwin', 'linux', 'win32'].includes(platform)) return {};
  // Cross-platform callers/tests must not recover a different host's environment.
  if (platform !== process.platform && !options.spawnSyncImpl) return {};
  const spawn = options.spawnSyncImpl ?? spawnSync;
  let accountShell = options.userShell;
  if (accountShell === undefined && platform !== 'win32') {
    try { accountShell = userInfo().shell; } catch {}
  }
  const shells = platform === 'win32'
    ? [...new Set([
      win32Path.join(getEnv(environment, 'ProgramFiles') || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      'pwsh.exe', resolveWindowsPowerShell(platform, environment),
    ])]
    : [...new Set([environment.SHELL, accountShell, platform === 'darwin' ? '/bin/zsh' : '/bin/bash'])]
      .filter((shell) => typeof shell === 'string' && isAbsolute(shell) && !shell.includes('\0'));
  const key = JSON.stringify([platform, home, shells]);
  if (!options.refresh && cachedShellEnvironment?.key === key && cachedShellEnvironment.expiresAt > Date.now()) {
    return cachedShellEnvironment.value;
  }
  const runProbe = (command, args, timeout = SHELL_PROBE_TIMEOUT_MS) => {
    try { return spawn(command, args, {
      env: {
        ...environment,
        TERM: environment.TERM || 'dumb',
        CUPPET_SHELL_PATH_PROBE: '1',
      },
      encoding: 'utf8',
      timeout,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    }); } catch { return null; }
  };
  let recovered = {};
  if (platform === 'win32') {
    const names = ['PATH', 'FNM_DIR', 'FNM_MULTISHELL_PATH'];
    const command = names.map((name) => `Write-Output ('${ENV_MARKER}${name}=' + [Environment]::GetEnvironmentVariable('${name}'))`).join('; ');
    for (const shell of shells) {
      let shellRecovered = {};
      for (const profile of [false, true]) {
        const result = runProbe(shell, ['-NoLogo', ...(profile ? [] : ['-NoProfile']), '-NonInteractive', '-Command', command]);
        if (result?.error || result?.status !== 0) continue;
        const next = markerEnvironment(result.stdout, names);
        shellRecovered = { ...shellRecovered, ...next, PATH: dedupePath([
          ...splitPath(next.PATH, ';'), ...splitPath(shellRecovered.PATH, ';'),
        ]).join(';') };
      }
      if (shellRecovered.PATH) { recovered = shellRecovered; break; }
    }
  } else {
    const names = ['PATH', '__MISE_DIFF'];
    const command = names.map((name) => `printf '${ENV_MARKER}${name}='; printenv ${name}; printf '\\n'`).join('; ');
    for (const shell of shells) {
      const result = runProbe(shell, ['-l', '-i', '-c', command]);
      if (result?.error || result?.status !== 0) continue;
      recovered = markerEnvironment(result.stdout, names);
      if (recovered.PATH) break;
    }
    if (!recovered.PATH && platform === 'darwin') {
      const result = runProbe('/bin/launchctl', ['getenv', 'PATH'], 2_000);
      if (!result?.error && result?.status === 0) recovered = { PATH: cleanPath(result.stdout) };
    }
  }
  // Never retain a failed lookup; successful snapshots expire and Connect can refresh them.
  cachedShellEnvironment = recovered.PATH ? { key, value: recovered, expiresAt: Date.now() + SHELL_CACHE_MS } : null;
  return recovered;
}

function markerEnvironment(stdout, names) {
  const environment = {};
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (const line of lines) {
    for (const name of names) {
      const marker = `${ENV_MARKER}${name}=`;
      if (!line.startsWith(marker)) continue;
      const value = cleanPath(line.slice(marker.length));
      if (value) environment[name] = value;
    }
  }
  return environment;
}

function fallbackCliPaths(environment, home, platform) {
  const isWin = platform === 'win32';
  const pathJoin = isWin ? win32Path.join : posixPath.join;
  const pnpmHome = getEnv(environment, 'PNPM_HOME');
  const bunInstall = getEnv(environment, 'BUN_INSTALL');
  const npmConfigPrefix = getEnv(environment, 'NPM_CONFIG_PREFIX', 'npm_config_prefix');
  const npmPrefixPath = npmConfigPrefix ? (isWin ? npmConfigPrefix : pathJoin(npmConfigPrefix, 'bin')) : '';
  const appData = getEnv(environment, 'APPDATA', 'AppData') || (isWin && home ? pathJoin(home, 'AppData', 'Roaming') : '');
  const localAppData = getEnv(environment, 'LOCALAPPDATA', 'LocalAppData') || (isWin && home ? pathJoin(home, 'AppData', 'Local') : '');

  const candidates = [
    npmPrefixPath,
    pnpmHome,
    getEnv(environment, 'GROK_BIN_DIR'),
    bunInstall ? pathJoin(bunInstall, 'bin') : '',
    npmPrefixPath ? '' : (appData ? pathJoin(appData, 'npm') : ''),
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
      localAppData ? pathJoin(localAppData, 'Programs', 'nodejs') : '',
      localAppData ? pathJoin(localAppData, 'Volta', 'bin') : '',
      localAppData ? pathJoin(localAppData, 'pnpm') : '',
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
    candidates = [posixPath.join('/Applications', bundle), posixPath.join(home, 'Applications', bundle)];
  } else if (platform === 'linux') {
    candidates = [copilot ? '/usr/share/code' : '/usr/share/antigravity', copilot ? '/opt/visual-studio-code' : '/opt/Antigravity'];
  }
  for (const path of candidates) {
    const executable = platform === 'win32'
      ? win32Path.join(path, copilot ? 'Code.exe' : 'Antigravity.exe')
      : platform === 'darwin' ? posixPath.join(path, 'Contents', 'MacOS', 'Electron') : posixPath.join(path, copilot ? 'code' : 'antigravity');
    try { check(executable, fsConstants.F_OK); return { label, path }; } catch {}
    if (platform === 'darwin' && !copilot) {
      try {
        check(posixPath.join(path, 'Contents', 'MacOS', 'Antigravity'), fsConstants.F_OK);
        return { label, path };
      } catch {}
    }
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
