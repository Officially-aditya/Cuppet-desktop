import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { acpCliDescriptor } from '../runtime/acp-cli-provider.mjs';

// Finder-launched macOS apps do not inherit the user's interactive shell PATH.
// Add the common user/package-manager locations without changing the priority of
// paths Electron already inherited. The runtime child inherits this PATH too.
extendCliSearchPath();

export async function cliAgentStatus(providerID) {
  const descriptor = acpCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');
  const command = String(process.env[descriptor.envOverride] || descriptor.command);
  const versionArgs = descriptor.id === 'grok-build' ? ['version'] : ['--version'];
  try {
    const result = await run(command, versionArgs, 4_000);
    const version = firstLine(result.stdout || result.stderr);
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      available: true,
      installed: true,
      version: version || null,
      loginHint: descriptor.loginHint,
      message: `${descriptor.label} CLI detected${version ? ` · ${version}` : ''}. Authentication stays inside the CLI.`,
    };
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /not found|ENOENT/i.test(String(error?.message ?? error));
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      available: false,
      installed: false,
      version: null,
      loginHint: descriptor.loginHint,
      message: missing ? `${descriptor.label} CLI is not installed or could not be found by Cuppet.` : `${descriptor.label} CLI could not be started: ${String(error?.message ?? error).slice(0, 300)}`,
    };
  }
}

function extendCliSearchPath() {
  const home = homedir();
  const existing = String(process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    process.env.CUPPET_CLI_PATH,
    process.env.PNPM_HOME,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : '',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
    home ? join(home, '.local', 'bin') : '',
    home ? join(home, '.opencode', 'bin') : '',
    home ? join(home, '.grok', 'bin') : '',
    home ? join(home, '.bun', 'bin') : '',
    home ? join(home, '.npm-global', 'bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);
  const seen = new Set();
  process.env.PATH = [...existing, ...candidates]
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}

function run(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    } catch (error) { rejectRun(error); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {}; rejectRun(new Error('Version check timed out.')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}
function firstLine(value) { return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''; }
