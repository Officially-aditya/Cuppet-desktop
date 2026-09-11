import { spawn } from 'node:child_process';
import { acpCliDescriptor } from '../runtime/acp-cli-provider.mjs';

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
      message: missing ? `${descriptor.label} CLI is not installed or is not on PATH.` : `${descriptor.label} CLI could not be started: ${String(error?.message ?? error).slice(0, 300)}`,
    };
  }
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
