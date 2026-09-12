import { spawn } from 'node:child_process';

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

export async function probeOpenCodeAuthentication(command = 'opencode', { runImpl = runCommand } = {}) {
  const result = await runImpl(command, ['auth', 'list'], STATUS_TIMEOUT_MS, { stdin: 'ignore' });
  return parseOpenCodeAuthList(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
}

function runCommand(command, args, timeoutMs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        stdio: [options.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: process.env,
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
