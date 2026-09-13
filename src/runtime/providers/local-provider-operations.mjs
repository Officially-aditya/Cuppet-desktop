import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { normalizeProviderInstallation } from './operations.mjs';
import { probeOpenCodeAuthentication } from './opencode-auth.mjs';

const RUN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;
const LINK_STATE_FILE = 'cli-agent-links.json';

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
    const executable = command();
    const state = await providerState(userData, descriptor.id);
    let version = null;
    try {
      const result = await runImpl(executable, descriptor.versionArgs, STATUS_TIMEOUT_MS, { stdin: 'ignore' });
      version = firstLine(result.stdout || result.stderr) || null;
    } catch (error) {
      const missing = error?.code === 'ENOENT' || /not found|ENOENT|command not found/i.test(String(error?.message ?? error));
      return {
        providerID: descriptor.id,
        label: descriptor.label,
        installed: false,
        installation: normalizeProviderInstallation({ detected: false, executable, source: state.installSource }),
        error: missing ? null : cleanError(error),
      };
    }

    const identity = await executableIdentityImpl(executable).catch(() => null);
    const recordedIdentity = normalizeStoredIdentity(state.executableIdentity);
    const ownershipMatches = state.installedByCuppet === true && executableIdentityMatches(recordedIdentity, identity);
    const spec = installSpec(descriptor.id, platform);
    const resolvedExecutable = identity?.realPath || identity?.resolvedPath || executable;
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      installed: true,
      version,
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
    await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    extendCliSearchPath();
    const detected = await detect();
    if (!detected.installed) throw new Error(`${descriptor.label} installation completed but Cuppet still could not find the CLI.`);
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
    await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    extendCliSearchPath();
    const after = await detect();
    if (!after.installed) throw new Error(`${descriptor.label} update completed but the CLI could no longer be found.`);
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
      'claude-code': { source: 'npm', script: "$ErrorActionPreference='Stop'; if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Claude Code ACP installation requires npm/Node.js 22+' }; npm install -g @agentclientprotocol/claude-agent-acp" },
      'grok-build': { source: 'managed', script: 'irm https://x.ai/cli/install.ps1 | iex' },
      'github-copilot': { source: 'managed', script: 'winget install --id GitHub.Copilot -e --silent --accept-package-agreements --accept-source-agreements' },
      'mistral-vibe': { source: 'managed', script: "$ErrorActionPreference='Stop'; if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex }; $uv=(Get-Command uv -ErrorAction SilentlyContinue).Source; if (-not $uv) { $uv=Join-Path $env:USERPROFILE '.local\\bin\\uv.exe' }; & $uv tool install mistral-vibe" },
      kiro: { source: 'managed', script: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
      antigravity: { source: 'managed', script: 'irm https://antigravity.google/cli/install.ps1 | iex' },
      opencode: { source: 'managed', script: "$ErrorActionPreference='Stop'; if (Get-Command npm -ErrorAction SilentlyContinue) { npm install -g opencode-ai } elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install opencode -y } elseif (Get-Command scoop -ErrorAction SilentlyContinue) { scoop install opencode } else { throw 'OpenCode automatic install needs npm, Chocolatey, or Scoop on Windows.' }" },
    };
    const spec = specs[id];
    return spec ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', spec.script], source: spec.source } : null;
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

function extendCliSearchPath() {
  const home = homedir();
  const existing = String(process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    process.env.CUPPET_CLI_PATH,
    process.env.PNPM_HOME,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
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
  ].filter(Boolean);
  const seen = new Set();
  process.env.PATH = [...existing, ...candidates].filter((entry) => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  }).join(delimiter);
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
  const value = String(command ?? '').trim();
  if (!value) return null;
  if (value.includes('/') || value.includes('\\')) {
    return executableAt(value) ? value : null;
  }
  const pathEntries = String(process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' && !value.toLowerCase().endsWith(extension.toLowerCase()) ? `${value}${extension}` : value);
      if (await executableAt(candidate)) return candidate;
    }
  }
  return null;
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
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        stdio: [options.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
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
function firstLine(value) { return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''; }
function cleanError(error) { return String(error instanceof Error ? error.message : error ?? '').replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
