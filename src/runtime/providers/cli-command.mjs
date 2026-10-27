import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { localCliLaunch } from '../local-cli-launch.mjs';
import { resolveWindowsPowerShell } from '../local-cli-environment.mjs';
import { redactCredentials } from '../credential-sanitization.mjs';

export function providerProcessEnvironment(inherited = process.env) {
  const environment = { ...inherited };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/** Retry only a cold-start timeout, once, with a larger budget. */
export async function probeProviderCommand(command, args, { runImpl = runProviderCommand, timeoutMs = 8_000, retryTimeoutMs = 30_000, ...options } = {}) {
  try { return await runImpl(command, args, timeoutMs, { stdin: 'ignore', ...options }); }
  catch (error) {
    if (options.signal?.aborted || !isProbeTimeout(error)) throw error;
    return runImpl(command, args, retryTimeoutMs, { stdin: 'ignore', ...options });
  }
}

export function isProbeTimeout(error) {
  return ['PROVIDER_TIMEOUT', 'ETIMEDOUT'].includes(error?.code) || /timed out/i.test(error?.message ?? '');
}

export function runProviderCommand(command, args, timeoutMs, options = {}) {
  const executable = process.platform === 'win32' && /^(?:powershell)(?:\.exe)?$/i.test(command)
    ? resolveWindowsPowerShell() : command;
  return new Promise((resolveRun, rejectRun) => {
    if (options.signal?.aborted) { rejectRun(new Error('Provider setup was cancelled.')); return; }
    let stdout = '';
    let stderr = '';
    let child;
    try {
      const launch = localCliLaunch(executable, args, { shell: options.shell });
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd ?? tmpdir(),
        stdio: [options.stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true, shell: launch.shell, detached: process.platform !== 'win32',
        env: providerProcessEnvironment(options.env ?? process.env),
      });
    } catch (error) { rejectRun(error); return; }
    let settled = false;
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { try { child.kill(); } catch {} });
          return;
        } catch {}
      }
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
      }
      try { child.kill(); } catch {}
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (error) rejectRun(error); else resolveRun(result);
    };
    const cancel = () => { stop(); finish(new Error('Provider setup was cancelled.')); };
    const timer = setTimeout(() => {
      stop();
      finish(Object.assign(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.${stderr ? ` ${redactCredentials(stderr).trim().slice(-1000)}` : ''}`), { code: 'PROVIDER_TIMEOUT' }));
    }, timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout?.on('data', (chunk) => { if (!options.discardOutput) stdout = `${stdout}${String(chunk)}`.slice(-64_000); });
    child.stderr?.on('data', (chunk) => { if (!options.discardOutput) stderr = `${stderr}${String(chunk)}`.slice(-64_000); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(Object.assign(new Error(redactCredentials(stderr || stdout || `${command} exited with code ${code}`).trim()), { code: code ?? undefined }));
    });
  });
}
