import { spawn } from 'node:child_process';
import { localCliLaunch } from '../local-cli-launch.mjs';
import { parseSemanticVersion } from './version-policy.mjs';
import { openCodeMcpEnvironment } from './opencode-mcp.mjs';

const STATUS_TIMEOUT_MS = 8_000;

export function parseOpenCodeAuthList(value) {
  const text = stripAnsi(String(value ?? '')).replace(/\r/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  const countMatch = text.match(/\b(\d+)\s+credentials?\b/i);
  const environmentMatch = text.match(/\b(\d+)\s+environment\s+variables?\b/i);
  const credentialCount = countMatch ? Number(countMatch[1]) : null;
  const environmentSummaryCount = environmentMatch ? Number(environmentMatch[1]) : null;
  if (Number.isFinite(credentialCount) && credentialCount > 0) {
    return { connected: true, source: 'credentials', credentialCount };
  }
  if (Number.isFinite(environmentSummaryCount) && environmentSummaryCount > 0) {
    return { connected: true, source: 'environment', environmentCount: environmentSummaryCount };
  }

  let section = '';
  let environmentCount = 0;
  let credentialBulletCount = 0;
  for (const line of lines) {
    if (/\bCredentials\b/i.test(line)) {
      section = 'credentials';
      continue;
    }
    if (/\bEnvironment\b/i.test(line)) {
      section = 'environment';
      continue;
    }
    if (!/[●•]\s+\S/.test(line)) continue;
    if (section === 'environment') environmentCount += 1;
    else if (section === 'credentials') credentialBulletCount += 1;
  }

  if (credentialBulletCount > 0) {
    return { connected: true, source: 'credentials', credentialCount: credentialBulletCount };
  }
  if (environmentCount > 0) {
    return { connected: true, source: 'environment', environmentCount };
  }

  return {
    connected: false,
    source: 'none',
    credentialCount: Number.isFinite(credentialCount) ? credentialCount : 0,
    environmentCount: Number.isFinite(environmentSummaryCount) ? environmentSummaryCount : environmentCount,
  };
}

export function parseOpenCodeV2AuthList(value) {
  let integrations;
  try { integrations = JSON.parse(String(value ?? '')); } catch {}
  if (!Array.isArray(integrations) || integrations.some((integration) => !integration || !Array.isArray(integration.connections))) {
    throw new Error('OpenCode returned an invalid authentication response.');
  }
  const credentialCount = integrations.reduce((count, integration) =>
    count + integration.connections.filter((connection) => connection?.type === 'credential').length, 0);
  return credentialCount > 0
    ? { connected: true, source: 'credentials', credentialCount }
    : { connected: false, source: 'none', credentialCount: 0, environmentCount: 0 };
}

export async function probeOpenCodeAuthentication(command = 'opencode', { runImpl = runCommand, version } = {}) {
  const v2 = (parseSemanticVersion(version)?.parts[0] ?? 0) >= 2;
  // V2's shared background service can fail independently of the installed CLI
  // and ACP runtime. Read its structured connections through a private server.
  const args = v2 ? ['auth', 'list', '--standalone', '--format', 'json'] : ['auth', 'list'];
  const result = await runImpl(command, args, STATUS_TIMEOUT_MS, { stdin: 'ignore', env: openCodeMcpEnvironment(process.env, version) });
  if (v2) return parseOpenCodeV2AuthList(result?.stdout);
  return parseOpenCodeAuthList(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
}

function runCommand(command, args, timeoutMs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      const isWindows = process.platform === 'win32';
      const useShell = typeof options.shell === 'boolean'
        ? options.shell
        : (isWindows && (
            /\.(cmd|bat)$/i.test(command) ||
            (!/\.exe$/i.test(command) && !command.toLowerCase().includes('powershell'))
          ));
      const launch = localCliLaunch(command, args, { shell: useShell });
      child = spawn(launch.command, launch.args, {
        stdio: [options.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: launch.shell,
        env: options.env ?? process.env,
      });
    } catch (error) {
      rejectRun(error);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      rejectRun(new Error(`${command} auth status timed out.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-64_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(Object.assign(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()), { code: code ?? undefined }));
    });
  });
}

function stripAnsi(value) {
  return value.replace(/\u001B(?:[@-_][0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '');
}
