import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, win32 as win32Path } from 'node:path';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { resolveLocalCliExecutable, resolveWindowsPowerShell } from '../local-cli-environment.mjs';
import { localCliLaunch } from '../local-cli-launch.mjs';
import { normalizeProviderInstallation } from './operations.mjs';
import { probeOpenCodeAuthentication } from './opencode-auth.mjs';
import { localProviderVersionLabel } from './version-policy.mjs';

const RUN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;
const LINK_STATE_FILE = 'cli-agent-links.json';
const INSTALLED_CLI_MARKER = '__CUPPET_INSTALLED_CLI__=';

const WINDOWS_OPENCODE_INSTALL = String.raw`
$ErrorActionPreference='Stop'
$cli = $null
if (Get-Command npm -ErrorAction SilentlyContinue) {
  npm install -g opencode-ai
  if ($LASTEXITCODE -ne 0) { npm install -g opencode-ai --force }
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode npm installation failed.' }
  $prefix = (npm prefix -g | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the OpenCode npm installation directory.' }
  $cli = Join-Path $prefix 'opencode.cmd'
} elseif (Get-Command choco -ErrorAction SilentlyContinue) {
  choco upgrade opencode -y
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode Chocolatey installation failed.' }
} elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
  $existing = Get-Command opencode -ErrorAction SilentlyContinue
  if ($existing) { scoop update opencode } else { scoop install opencode }
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode Scoop installation failed.' }
} else { throw 'OpenCode automatic install needs npm, Chocolatey, or Scoop on Windows.' }
if (-not $cli) { $cli = (Get-Command opencode -CommandType Application -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $cli)) { throw 'OpenCode installer did not produce a CLI launcher.' }
& $cli --version
if ($LASTEXITCODE -ne 0) { throw 'OpenCode was installed but its CLI could not start.' }
Write-Output "__CUPPET_INSTALLED_CLI__=$cli"
`;

// Finder-launched macOS apps do not inherit the user's interactive shell PATH.
extendCliSearchPath();

/**
 * Runtime-owned local CLI lifecycle operations.
 *
 * Detection/probing are read-only. Installation/update/authentication are explicit
 * mutations. Cuppet update authority is bound to the executable identity it actually
 * installed, not merely to a historical "installedByCuppet" marker.
 */
export function localProviderOperations(providerID, {
  userData,
  runImpl = run,
  platform = process.platform,
  now = () => Date.now(),
  executableIdentityImpl = executableIdentity,
} = {}) {
  const descriptor = localCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');

  const command = () => {
    extendCliSearchPath();
    return String(process.env[descriptor.envOverride] || descriptor.command);
  };

  const detect = async () => {
    const rawCommand = command();
    const state = await providerState(userData, descriptor.id);
    let resolved = await resolveExecutablePath(rawCommand);
    const recordedIdentity = normalizeStoredIdentity(state.executableIdentity);
    if (!resolved && !process.env[descriptor.envOverride] && state.installedByCuppet && recordedIdentity?.resolvedPath && await executableAt(recordedIdentity.resolvedPath)) {
      resolved = recordedIdentity.resolvedPath;
      extendCliSearchPath([dirname(resolved)]);
    }
    let executable = resolved || rawCommand;
    let result;
    let probeError;
    try {
      result = await runImpl(executable, descriptor.versionArgs, STATUS_TIMEOUT_MS, { stdin: 'ignore' });
    } catch (error) { probeError = error; }
    if (probeError && !resolved && descriptor.id === 'opencode' && platform === 'win32' && !process.env[descriptor.envOverride]) {
      const npmExecutable = await findOpenCodeNpmExecutable(runImpl);
      if (npmExecutable) {
        resolved = executable = npmExecutable;
        extendCliSearchPath([dirname(executable)]);
        try {
          result = await runImpl(executable, descriptor.versionArgs, STATUS_TIMEOUT_MS, { stdin: 'ignore' });
          probeError = null;
        } catch (error) { probeError = error; }
      }
    }
    const installed = Boolean(result || (resolved && probeError?.code !== 'ENOENT'));
    const version = result ? localProviderVersionLabel(descriptor.id, result) : null;
    if (!installed) {
      const errorMsg = String(probeError?.message ?? probeError ?? '');
      const missing = probeError?.code === 'ENOENT' || /not found|ENOENT|command not found|is not recognized as an internal or external command/i.test(errorMsg);
      return {
        providerID: descriptor.id,
        label: descriptor.label,
        installed: false,
        installation: normalizeProviderInstallation({ detected: false, executable, source: state.installSource }),
        error: missing ? null : cleanError(probeError),
      };
    }

    const identity = await executableIdentityImpl(executable).catch(() => null);
    const ownershipMatches = state.installedByCuppet === true && executableIdentityMatches(recordedIdentity, identity);
    const spec = installSpec(descriptor.id, platform);
    const resolvedExecutable = identity?.realPath || identity?.resolvedPath || executable;
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      installed: true,
      version,
      ...(probeError ? { error: cleanError(probeError) } : {}),
      installation: normalizeProviderInstallation({
        detected: true,
        executable: resolvedExecutable,
        version,
        source: ownershipMatches ? state.installSource : 'unknown',
        ownedByCuppet: ownershipMatches,
        canUpdate: ownershipMatches && Boolean(updateSpec(descriptor.id, platform, state.installSource || spec?.source)),
        identity,
      }),
    };
  };

  const probe = async () => {
    const detected = await detect();
    if (!detected.installed) return { ...detected, connected: false, available: false, probe: 'not-installed' };
    const marker = await providerState(userData, descriptor.id);
    let providerReady = false;
    let probeError = null;
    let authentication = null;
    try {
      if (descriptor.id === 'opencode') {
        authentication = await probeOpenCodeAuthentication(detected.installation.executable, { runImpl });
        providerReady = authentication.connected === true;
      } else {
        providerReady = await probeConnection(descriptor, detected.installation.executable, runImpl);
      }
    } catch (error) { probeError = cleanError(error); }
    // OpenCode exposes an authoritative read-only credential listing. Never let
    // a historical Cuppet link marker override a current zero-credential result.
    const connected = descriptor.id === 'opencode'
      ? Boolean(providerReady)
      : Boolean(providerReady || marker.linkedAt);
    return {
      ...detected,
      connected,
      available: connected,
      probe: providerReady ? 'provider' : marker.linkedAt && descriptor.id !== 'opencode' ? 'linked-marker' : 'not-authenticated',
      ...(authentication ? { authentication } : {}),
      ...(probeError ? { probeError } : {}),
    };
  };

  const install = async () => {
    const before = await detect();
    if (before.installed) return before;
    const spec = installSpec(descriptor.id, platform);
    if (!spec) throw new Error(`Automatic ${descriptor.label} installation is not available on this platform yet.`);
    const installed = await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    await applyInstallerExecutable(installed);
    extendCliSearchPath();
    const detected = await detect();
    if (!detected.installed || detected.error) throw new Error(`${descriptor.label} installation could not be verified.${detected.error ? ` ${detected.error}` : ' The installer did not produce a usable CLI.'}`);
    await markInstalled(userData, descriptor.id, {
      source: spec.source,
      installedAt: now(),
      executableIdentity: detected.installation.identity,
    });
    return detect();
  };

  const update = async () => {
    const detected = await detect();
    if (!detected.installed) throw new Error(`${descriptor.label} is not installed.`);
    if (!detected.installation.ownedByCuppet || detected.installation.source === 'unknown') {
      throw new Error(`Cuppet does not own this ${descriptor.label} installation, so it will not update it automatically.`);
    }
    const spec = updateSpec(descriptor.id, platform, detected.installation.source);
    if (!spec) throw new Error(`Automatic ${descriptor.label} updates are not available for this installation source.`);
    const updated = await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    await applyInstallerExecutable(updated);
    extendCliSearchPath();
    const after = await detect();
    if (!after.installed || after.error) throw new Error(`${descriptor.label} update could not be verified.${after.error ? ` ${after.error}` : ' The CLI could not be found.'}`);
    await markInstalled(userData, descriptor.id, {
      source: detected.installation.source,
      installedAt: now(),
      updatedAt: now(),
      executableIdentity: after.installation.identity,
    });
    return detect();
  };

  const authenticate = async () => {
    const detected = await detect();
    if (!detected.installed) throw new Error(`${descriptor.label} must be installed before authentication.`);
    const current = await probe();
    if (current.connected) return current;
    const login = loginSpec(descriptor.id, detected.installation.executable);
    if (!login) {
      await markLinked(userData, descriptor.id, now());
      return probe();
    }
    await runImpl(login.command, login.args, RUN_TIMEOUT_MS, {
      stdin: login.stdin ?? 'pipe',
      autoEnter: login.autoEnter === true,
      env: login.env,
    });
    await markLinked(userData, descriptor.id, now());
    const next = await probe();
    // Some providers keep account sessions in the OS keyring and expose no
    // zero-usage identity probe. Successful official auth remains provisional;
    // first runtime use is still authoritative.
    return next.connected ? next : {
      ...next,
      available: true,
      connected: true,
      probe: 'auth-flow-completed',
    };
  };

  const status = async () => statusProjection(descriptor, await probe(), platform);
  const connect = async () => {
    const detected = await detect();
    if (!detected.installed) await install();
    await authenticate();
    return status();
  };

  return Object.freeze({ detect, probe, install, update, authenticate, status, connect });
}

function statusProjection(descriptor, state, platform) {
  const installed = state.installed === true;
  const connected = state.connected === true;
  const version = state.version ?? null;
  const canAutoInstall = Boolean(installSpec(descriptor.id, platform));
  return {
    providerID: descriptor.id,
    label: descriptor.label,
    available: connected,
    installed,
    connected,
    version,
    action: connected ? 'ready' : 'connect',
    canAutoInstall,
    installation: state.installation,
    message: !installed
      ? state.error
        ? `${descriptor.label} could not be started: ${state.error}`
        : `${descriptor.label} is not installed yet. Cuppet will install it when you connect.`
      : connected
        ? `${descriptor.label} is connected and ready to use in Cuppet${version ? ` · ${version}` : ''}.`
        : descriptor.id === 'opencode' && state.authentication?.connected === false
          ? 'OpenCode is installed, but no authenticated provider credentials were found. Run `opencode auth login` in Terminal, then refresh or reconnect.'
          : `${descriptor.label} is installed. Connect once and Cuppet will open the provider's official sign-in flow.`,
  };
}

export function installSpec(providerID, platform = process.platform) {
  const id = String(providerID ?? '').trim().toLowerCase();
  if (platform === 'darwin' || platform === 'linux') {
    const specs = {
      opencode: { source: 'managed', script: 'curl -fsSL https://opencode.ai/install | bash' },
      'claude-code': { source: 'npm', script: 'npm install -g @agentclientprotocol/claude-agent-acp' },
      'grok-build': { source: 'managed', script: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
      'github-copilot': { source: 'managed', script: 'curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" bash' },
      'mistral-vibe': { source: 'managed', script: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash' },
      kiro: { source: 'managed', script: 'curl -fsSL https://cli.kiro.dev/install | bash' },
      antigravity: { source: 'managed', script: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    };
    const spec = specs[id];
    return spec ? { command: '/bin/bash', args: ['-lc', spec.script], source: spec.source } : null;
  }
  if (platform === 'win32') {
    const specs = {
      'claude-code': { source: 'npm', script: "$ErrorActionPreference='Stop'; $npmDir = if ($env:APPDATA) { Join-Path $env:APPDATA 'npm' } else { '' }; if ($npmDir -and (Test-Path (Join-Path $npmDir 'claude-agent-acp.cmd'))) { exit 0 }; if (Get-Command claude-agent-acp -ErrorAction SilentlyContinue) { exit 0 }; if ($npmDir -and (Test-Path $npmDir) -and -not ($env:PATH -split ';' -contains $npmDir)) { $env:PATH = \"$npmDir;$env:PATH\" }; if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Claude Code ACP installation requires npm/Node.js 22+' }; npm install -g @agentclientprotocol/claude-agent-acp; if ($LASTEXITCODE -ne 0) { if ($npmDir -and (Test-Path (Join-Path $npmDir 'claude-agent-acp.cmd'))) { exit 0 }; npm install -g @agentclientprotocol/claude-agent-acp --force }" },
      'grok-build': { source: 'managed', script: 'irm https://x.ai/cli/install.ps1 | iex' },
      'github-copilot': { source: 'managed', script: 'winget install --id GitHub.Copilot -e --silent --accept-package-agreements --accept-source-agreements' },
      'mistral-vibe': { source: 'managed', script: "$ErrorActionPreference='Stop'; if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex }; $uv=(Get-Command uv -ErrorAction SilentlyContinue).Source; if (-not $uv) { $uv=Join-Path $env:USERPROFILE '.local\\bin\\uv.exe' }; & $uv tool install mistral-vibe" },
      kiro: { source: 'managed', script: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
      antigravity: { source: 'managed', script: 'irm https://antigravity.google/cli/install.ps1 | iex' },
      opencode: { source: 'managed', script: WINDOWS_OPENCODE_INSTALL },
    };
    const spec = specs[id];
    const powerShellCmd = resolveWindowsPowerShell(platform);
    return spec ? { command: powerShellCmd, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', spec.script], source: spec.source } : null;
  }
  return null;
}

export function updateSpec(providerID, platform = process.platform, source = '') {
  const install = installSpec(providerID, platform);
  if (!install) return null;
  const normalizedSource = String(source || install.source || '').toLowerCase();
  if (!normalizedSource || normalizedSource === 'unknown' || normalizedSource !== install.source) return null;
  // Official installers and package-manager install commands are expected to be
  // idempotent upgrades. This path is reachable only for Cuppet-owned installs.
  return install;
}

export function loginSpec(providerID, commandOverride = '') {
  const id = String(providerID ?? '').trim().toLowerCase();
  const descriptor = localCliDescriptor(id);
  if (!descriptor) return null;
  const command = commandOverride || descriptor.command;
  switch (id) {
    case 'opencode': return null;
    case 'claude-code': return { command, args: ['--cli', 'auth', 'login'] };
    case 'grok-build': return { command, args: ['login'] };
    case 'github-copilot': return { command, args: ['login', '--web-flow'] };
    case 'kiro': return { command, args: ['login', '--license', 'free'] };
    case 'mistral-vibe': return { command: siblingCommand(command, 'vibe'), args: ['--setup'], autoEnter: true };
    case 'antigravity': return { command, args: ['--mode=plan', '--sandbox', '--output-format', 'json', '--print-timeout', '5m', '-p', 'Reply only with READY. This is a Cuppet connection check; do not modify anything.'] };
    default: return null;
  }
}

async function probeConnection(descriptor, command, runImpl) {
  if (descriptor.id === 'claude-code') {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
    await runImpl(command, ['--cli', 'auth', 'status', '--json'], STATUS_TIMEOUT_MS, { stdin: 'ignore', discardOutput: true });
    return true;
  }
  if (descriptor.id === 'kiro') {
    await runImpl(command, ['whoami', '--format', 'json'], STATUS_TIMEOUT_MS, { stdin: 'ignore' });
    return true;
  }
  if (descriptor.id === 'grok-build') {
    if (process.env.XAI_API_KEY) return true;
    return exists(join(homedir(), '.grok', 'auth.json'));
  }
  if (descriptor.id === 'github-copilot') {
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (process.platform === 'darwin') {
      try { await runImpl('/usr/bin/security', ['find-generic-password', '-s', 'copilot-cli'], STATUS_TIMEOUT_MS, { stdin: 'ignore', discardOutput: true }); return true; } catch {}
    }
    try { await runImpl('gh', ['auth', 'token'], STATUS_TIMEOUT_MS, { stdin: 'ignore', discardOutput: true }); return true; } catch {}
    return false;
  }
  if (descriptor.id === 'mistral-vibe') {
    if (process.env.MISTRAL_API_KEY) return true;
    return nonEmpty(join(homedir(), '.vibe', '.env'));
  }
  if (descriptor.id === 'antigravity') return Boolean(process.env.GEMINI_API_KEY);
  return false;
}

async function providerState(userData, providerID) {
  if (!userData) return {};
  try {
    const parsed = JSON.parse(await readFile(join(userData, LINK_STATE_FILE), 'utf8'));
    const state = parsed?.providers?.[providerID];
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}

async function markLinked(userData, providerID, linkedAt) {
  if (!userData) return;
  await patchProviderState(userData, providerID, { linkedAt });
}
async function markInstalled(userData, providerID, patch) {
  if (!userData) return;
  await patchProviderState(userData, providerID, {
    installedByCuppet: true,
    installSource: patch.source || 'managed',
    installedAt: patch.installedAt,
    executableIdentity: patch.executableIdentity ?? null,
    ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
  });
}
async function patchProviderState(userData, providerID, patch) {
  const path = join(userData, LINK_STATE_FILE);
  let parsed = { version: 3, providers: {} };
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current && typeof current === 'object') parsed = { version: 3, providers: { ...(current.providers ?? {}) } };
  } catch {}
  parsed.providers[providerID] = { ...(parsed.providers[providerID] ?? {}), ...patch };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

function extendCliSearchPath(additional = []) {
  const home = homedir();
  const existing = String(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    process.env.CUPPET_CLI_PATH,
    process.env.PNPM_HOME,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : '',
    process.env.APPDATA ? (process.platform === 'win32' ? win32Path.join(process.env.APPDATA, 'npm') : join(process.env.APPDATA, 'npm')) : (process.platform === 'win32' && home ? win32Path.join(home, 'AppData', 'Roaming', 'npm') : ''),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin') : '',
    home ? join(home, '.local', 'bin') : '',
    home ? join(home, '.opencode', 'bin') : '',
    home ? join(home, '.grok', 'bin') : '',
    home ? join(home, '.kiro', 'bin') : '',
    home ? join(home, '.vibe', 'bin') : '',
    home ? join(home, '.copilot', 'bin') : '',
    home ? join(home, '.bun', 'bin') : '',
    home ? join(home, '.npm-global', 'bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || (home ? win32Path.join(home, 'AppData', 'Local') : '');
    candidates.push(
      win32Path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      win32Path.join(systemRoot, 'System32'),
      systemRoot,
      win32Path.join(systemRoot, 'System32', 'OpenSSH'),
      win32Path.join(programFiles, 'PowerShell', '7'),
      win32Path.join(programFiles, 'Git', 'cmd'),
      win32Path.join(programFiles, 'Git', 'bin'),
      localAppData ? win32Path.join(localAppData, 'Programs', 'Git', 'cmd') : '',
      localAppData ? win32Path.join(localAppData, 'Programs', 'Git', 'bin') : '',
      win32Path.join(programFiles, 'nodejs'),
      win32Path.join(programFilesX86, 'nodejs'),
    );
  }
  const seen = new Set();
  const nextPath = [...additional, ...existing, ...candidates.filter(Boolean)].filter((entry) => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  }).join(delimiter);
  process.env.PATH = nextPath;
  if (process.platform === 'win32') process.env.Path = nextPath;
}

async function executableIdentity(command) {
  const resolvedPath = await resolveExecutablePath(command);
  if (!resolvedPath) return null;
  const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
  const metadata = await stat(realPath).catch(() => null);
  if (!metadata?.isFile()) return null;
  return {
    resolvedPath,
    realPath,
    ...(Number.isFinite(Number(metadata.dev)) ? { dev: Number(metadata.dev) } : {}),
    ...(Number.isFinite(Number(metadata.ino)) ? { ino: Number(metadata.ino) } : {}),
    size: Number(metadata.size),
    mtimeMs: Math.trunc(Number(metadata.mtimeMs)),
  };
}

async function resolveExecutablePath(command) {
  const resolved = resolveLocalCliExecutable(command);
  return resolved && await executableAt(resolved) ? resolved : null;
}

async function findOpenCodeNpmExecutable(runImpl) {
  try {
    const result = await runImpl('npm', ['prefix', '-g'], STATUS_TIMEOUT_MS, { stdin: 'ignore' });
    const prefix = String(result.stdout ?? '').trim().split(/\r?\n/).at(-1)?.trim();
    if (!prefix || !win32Path.isAbsolute(prefix)) return null;
    for (const name of ['opencode.cmd', 'opencode.exe']) {
      const path = win32Path.join(prefix, name);
      if (await executableAt(path)) return path;
    }
  } catch {}
  return null;
}

async function applyInstallerExecutable(result) {
  const line = String(result?.stdout ?? '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.startsWith(INSTALLED_CLI_MARKER));
  const path = line?.slice(INSTALLED_CLI_MARKER.length);
  if (path && await executableAt(path)) extendCliSearchPath([dirname(path)]);
}

async function executableAt(path) {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableIdentityMatches(recorded, current) {
  if (!recorded && !current) return true;
  if (!recorded || !current) return false;
  if (recorded.realPath && current.realPath && recorded.realPath !== current.realPath) return false;
  if (Number.isFinite(recorded.dev) && Number.isFinite(recorded.ino) && Number.isFinite(current.dev) && Number.isFinite(current.ino)) {
    return recorded.dev === current.dev && recorded.ino === current.ino;
  }
  return recorded.resolvedPath === current.resolvedPath && recorded.realPath === current.realPath;
}

function normalizeStoredIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resolvedPath = typeof value.resolvedPath === 'string' ? value.resolvedPath : '';
  const realPath = typeof value.realPath === 'string' ? value.realPath : '';
  if (!resolvedPath && !realPath) return null;
  return {
    resolvedPath: resolvedPath || realPath,
    realPath: realPath || resolvedPath,
    ...(Number.isFinite(Number(value.dev)) ? { dev: Number(value.dev) } : {}),
    ...(Number.isFinite(Number(value.ino)) ? { ino: Number(value.ino) } : {}),
    ...(Number.isFinite(Number(value.size)) ? { size: Number(value.size) } : {}),
    ...(Number.isFinite(Number(value.mtimeMs)) ? { mtimeMs: Number(value.mtimeMs) } : {}),
  };
}

function run(command, args, timeoutMs, options = {}) {
  let executable = command;
  if (process.platform === 'win32') {
    const lower = String(command || '').toLowerCase();
    if (lower === 'powershell.exe' || lower === 'powershell') {
      executable = resolveWindowsPowerShell();
    }
  }
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      const isWindows = process.platform === 'win32';
      const useShell = typeof options.shell === 'boolean'
        ? options.shell
        : (isWindows && (
            /\.(cmd|bat)$/i.test(executable) ||
            (!/\.exe$/i.test(executable) && !executable.toLowerCase().includes('powershell'))
          ));
      const launch = localCliLaunch(executable, args, { shell: useShell });
      child = spawn(launch.command, launch.args, {
        stdio: [options.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: launch.shell,
        env: { ...process.env, ...(options.env ?? {}) },
      });
    } catch (error) { rejectRun(error); return; }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      rejectRun(new Error(`${command} timed out.`));
    }, timeoutMs);
    const autoTimers = [];
    if (options.autoEnter && child.stdin) {
      for (const delay of [900, 2200]) autoTimers.push(setTimeout(() => { try { child.stdin.write('\n'); } catch {} }, delay));
    }
    child.stdout?.on('data', (chunk) => { if (!options.discardOutput) stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.stderr?.on('data', (chunk) => { if (!options.discardOutput) stderr = `${stderr}${String(chunk)}`.slice(-64_000); });
    child.once('error', (error) => { clearTimeout(timer); autoTimers.forEach(clearTimeout); rejectRun(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      autoTimers.forEach(clearTimeout);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(Object.assign(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()), { code: code === null ? undefined : code }));
    });
  });
}

function siblingCommand(command, sibling) {
  const value = String(command || '');
  if (!value.includes('/') && !value.includes('\\')) return sibling;
  return join(dirname(value), process.platform === 'win32' ? `${sibling}.exe` : sibling);
}
async function exists(path) { try { await access(path, fsConstants.F_OK); return true; } catch { return false; } }
async function nonEmpty(path) { try { return (await readFile(path, 'utf8')).trim().length > 0; } catch { return false; } }
function cleanError(error) { return String(error instanceof Error ? error.message : error ?? '').replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
