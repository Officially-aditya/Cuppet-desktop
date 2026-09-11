import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { localCliDescriptor } from '../runtime/local-cli-descriptors.mjs';

const RUN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;
const LINK_STATE_FILE = 'cli-agent-links.json';

// Finder-launched macOS apps do not inherit the user's interactive shell PATH.
// Add common user/package-manager locations without changing the priority of paths
// Electron already inherited. The runtime child inherits this PATH too.
extendCliSearchPath();

export async function cliAgentStatus(providerID, { userData } = {}) {
  const descriptor = localCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');
  extendCliSearchPath();
  const command = String(process.env[descriptor.envOverride] || descriptor.command);
  let version = null;
  try {
    const result = await run(command, descriptor.versionArgs, STATUS_TIMEOUT_MS, { stdin: 'ignore' });
    version = firstLine(result.stdout || result.stderr) || null;
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /not found|ENOENT|command not found/i.test(String(error?.message ?? error));
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      available: false,
      installed: false,
      connected: false,
      version: null,
      action: 'connect',
      canAutoInstall: canAutoInstall(descriptor.id),
      message: missing
        ? `${descriptor.label} is not installed yet. Cuppet will install it when you connect.`
        : `${descriptor.label} could not be started: ${cleanError(error)}`,
    };
  }

  const marker = await linkedMarker(userData, descriptor.id);
  const probed = await probeConnection(descriptor, command).catch(() => false);
  const connected = descriptor.id === 'opencode' ? true : Boolean(probed || marker);
  return {
    providerID: descriptor.id,
    label: descriptor.label,
    available: connected,
    installed: true,
    connected,
    version,
    action: connected ? 'ready' : 'connect',
    canAutoInstall: true,
    message: connected
      ? `${descriptor.label} is connected and ready to use in Cuppet${version ? ` · ${version}` : ''}.`
      : `${descriptor.label} is installed. Connect once and Cuppet will open the provider's official sign-in flow.`,
  };
}

export async function cliAgentConnect(providerID, { userData } = {}) {
  const descriptor = localCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');
  extendCliSearchPath();

  let status = await cliAgentStatus(descriptor.id, { userData });
  if (!status.installed) {
    const install = installSpec(descriptor.id, process.platform);
    if (!install) throw new Error(`Automatic ${descriptor.label} installation is not available on this platform yet.`);
    await run(install.command, install.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: install.env });
    extendCliSearchPath();
    status = await cliAgentStatus(descriptor.id, { userData });
    if (!status.installed) throw new Error(`${descriptor.label} installation completed but Cuppet still could not find the CLI.`);
  }

  if (status.connected) return status;
  const login = loginSpec(descriptor.id, String(process.env[descriptor.envOverride] || descriptor.command));
  if (!login) {
    await markLinked(userData, descriptor.id);
    return cliAgentStatus(descriptor.id, { userData });
  }

  await run(login.command, login.args, RUN_TIMEOUT_MS, {
    stdin: login.stdin ?? 'pipe',
    autoEnter: login.autoEnter === true,
    env: login.env,
  });
  await markLinked(userData, descriptor.id);
  const next = await cliAgentStatus(descriptor.id, { userData });
  // Some providers keep account sessions exclusively in the OS keyring and expose
  // no zero-usage identity probe. A successfully completed official login flow is
  // authoritative enough for the host; the provider still validates it on first use.
  return next.connected ? next : {
    ...next,
    available: true,
    connected: true,
    action: 'ready',
    message: `${descriptor.label} sign-in completed. Cuppet will verify the provider session again when it is used.`,
  };
}

export function installSpec(providerID, platform = process.platform) {
  const id = String(providerID ?? '').trim().toLowerCase();
  if (platform === 'darwin' || platform === 'linux') {
    const scripts = {
      opencode: 'curl -fsSL https://opencode.ai/install | bash',
      'grok-build': 'curl -fsSL https://x.ai/cli/install.sh | bash',
      'github-copilot': 'curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" bash',
      'mistral-vibe': 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
      kiro: 'curl -fsSL https://cli.kiro.dev/install | bash',
      antigravity: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    };
    return scripts[id] ? { command: '/bin/bash', args: ['-lc', scripts[id]] } : null;
  }
  if (platform === 'win32') {
    const scripts = {
      'grok-build': "irm https://x.ai/cli/install.ps1 | iex",
      'github-copilot': 'winget install --id GitHub.Copilot -e --silent --accept-package-agreements --accept-source-agreements',
      'mistral-vibe': "$ErrorActionPreference='Stop'; if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex }; $uv=(Get-Command uv -ErrorAction SilentlyContinue).Source; if (-not $uv) { $uv=Join-Path $env:USERPROFILE '.local\\bin\\uv.exe' }; & $uv tool install mistral-vibe",
      kiro: "irm 'https://cli.kiro.dev/install.ps1' | iex",
      antigravity: 'irm https://antigravity.google/cli/install.ps1 | iex',
      opencode: "$ErrorActionPreference='Stop'; if (Get-Command npm -ErrorAction SilentlyContinue) { npm install -g opencode-ai } elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install opencode -y } elseif (Get-Command scoop -ErrorAction SilentlyContinue) { scoop install opencode } else { throw 'OpenCode automatic install needs npm, Chocolatey, or Scoop on Windows.' }",
    };
    return scripts[id] ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scripts[id]] } : null;
  }
  return null;
}

export function loginSpec(providerID, commandOverride = '') {
  const id = String(providerID ?? '').trim().toLowerCase();
  const descriptor = localCliDescriptor(id);
  if (!descriptor) return null;
  const command = commandOverride || descriptor.command;
  switch (id) {
    case 'opencode':
      // OpenCode ships usable free models; provider-specific accounts are optional.
      return null;
    case 'grok-build':
      return { command, args: ['login'] };
    case 'github-copilot':
      return { command, args: ['login', '--web-flow'] };
    case 'kiro':
      return { command, args: ['login', '--license', 'free'] };
    case 'mistral-vibe':
      return { command: siblingCommand(command, 'vibe'), args: ['--setup'], autoEnter: true };
    case 'antigravity':
      return { command, args: ['--mode=plan', '--sandbox', '--output-format', 'json', '--print-timeout', '5m', '-p', 'Reply only with READY. This is a Cuppet connection check; do not modify anything.'] };
    default:
      return null;
  }
}

function canAutoInstall(providerID) { return Boolean(installSpec(providerID, process.platform)); }

async function probeConnection(descriptor, command) {
  if (descriptor.id === 'opencode') return true;
  if (descriptor.id === 'kiro') {
    await run(command, ['whoami', '--format', 'json'], STATUS_TIMEOUT_MS, { stdin: 'ignore' });
    return true;
  }
  if (descriptor.id === 'grok-build') {
    if (process.env.XAI_API_KEY) return true;
    if (await exists(join(homedir(), '.grok', 'auth.json'))) return true;
    return false;
  }
  if (descriptor.id === 'github-copilot') {
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (process.platform === 'darwin') {
      try { await run('/usr/bin/security', ['find-generic-password', '-s', 'copilot-cli'], STATUS_TIMEOUT_MS, { stdin: 'ignore', discardOutput: true }); return true; } catch {}
    }
    try { await run('gh', ['auth', 'token'], STATUS_TIMEOUT_MS, { stdin: 'ignore', discardOutput: true }); return true; } catch {}
    return false;
  }
  if (descriptor.id === 'mistral-vibe') {
    if (process.env.MISTRAL_API_KEY) return true;
    if (await nonEmpty(join(homedir(), '.vibe', '.env'))) return true;
    return false;
  }
  if (descriptor.id === 'antigravity') {
    if (process.env.GEMINI_API_KEY) return true;
    return false;
  }
  return false;
}

async function linkedMarker(userData, providerID) {
  if (!userData) return false;
  try {
    const parsed = JSON.parse(await readFile(join(userData, LINK_STATE_FILE), 'utf8'));
    return Boolean(parsed?.providers?.[providerID]?.linkedAt);
  } catch { return false; }
}

async function markLinked(userData, providerID) {
  if (!userData) return;
  const path = join(userData, LINK_STATE_FILE);
  let parsed = { version: 1, providers: {} };
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current && typeof current === 'object') parsed = { version: 1, providers: { ...(current.providers ?? {}) } };
  } catch {}
  parsed.providers[providerID] = { linkedAt: Date.now() };
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
