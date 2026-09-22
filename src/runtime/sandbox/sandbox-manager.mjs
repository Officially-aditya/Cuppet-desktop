import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { sanitizeEnvironment } from './env-sanitizer.mjs';
import { getMacSeatbeltSpawnSpec } from './mac-seatbelt-driver.mjs';
import { getLinuxBwrapSpawnSpec } from './linux-bwrap-driver.mjs';

const MAX_OUTPUT_BYTES = 128 * 1024;

export class SandboxManager {
  #platform;
  #seatbeltAvailable = null;
  #bwrapAvailable = null;

  constructor({ platform = process.platform } = {}) {
    this.#platform = platform;
  }

  async isAvailable() {
    if (this.#platform === 'darwin') {
      if (this.#seatbeltAvailable === null) {
        this.#seatbeltAvailable = await stat('/usr/bin/sandbox-exec')
          .then((s) => s.isFile())
          .catch(() => false);
      }
      return this.#seatbeltAvailable;
    }

    if (this.#platform === 'linux') {
      if (this.#bwrapAvailable === null) {
        this.#bwrapAvailable = await checkCommandAvailable('bwrap');
      }
      return this.#bwrapAvailable;
    }

    return false;
  }

  async getCapabilities() {
    const available = await this.isAvailable();
    const driverName = this.#platform === 'darwin'
      ? (available ? 'mac-seatbelt' : 'none')
      : this.#platform === 'linux'
      ? (available ? 'linux-bwrap' : 'none')
      : 'none';

    return {
      available,
      driverName,
      platform: this.#platform,
      networkIsolation: available,
      credentialProtection: available,
    };
  }

  /**
   * Generates the spawn specification for a command under the active sandbox policy.
   *
   * @param {string} command
   * @param {import('./types.mjs').SandboxPolicy} policy
   * @param {{ enabled?: boolean }} [options={}]
   * @returns {Promise<{ command: string, args: string[], shell: boolean, env: Record<string, string>, driverName: string }>}
   */
  async getSpawnSpec(command, policy, { enabled = true } = {}) {
    const env = sanitizeEnvironment(process.env, policy?.envOverrides);

    if (!enabled) {
      return { command, args: [], shell: true, env, driverName: 'host-fallback' };
    }

    if (this.#platform === 'darwin' && (await this.isAvailable())) {
      const spec = await getMacSeatbeltSpawnSpec(command, policy);
      return { ...spec, env, driverName: 'mac-seatbelt' };
    }

    if (this.#platform === 'linux' && (await this.isAvailable())) {
      const spec = await getLinuxBwrapSpawnSpec(command, policy);
      return { ...spec, env, driverName: 'linux-bwrap' };
    }

    return { command, args: [], shell: true, env, driverName: 'host-fallback' };
  }

  /**
   * Executes a command within the native sandbox.
   *
   * @param {string} command
   * @param {string} cwd
   * @param {import('./types.mjs').SandboxPolicy} policy
   * @param {{ timeoutMs?: number, signal?: AbortSignal, enabled?: boolean }} [options={}]
   * @returns {Promise<import('./types.mjs').SandboxExecutionResult>}
   */
  async execute(command, cwd, policy, { timeoutMs = 30000, signal, enabled = true } = {}) {
    const realCwd = await realpath(cwd).catch(() => cwd);
    const spawnSpec = await this.getSpawnSpec(command, policy, { enabled });

    return new Promise((resolvePromise, reject) => {
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: realCwd,
        shell: spawnSpec.shell,
        env: spawnSpec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let exited = false;
      let stdoutEnded = false;
      let stderrEnded = false;
      let exitCode = null;
      let killedSignal = null;
      let drainTimer = null;
      let forceTimer = null;
      let timedOut = false;

      const append = (target, chunk) => {
        const next = target + chunk.toString('utf8');
        return Buffer.byteLength(next) <= MAX_OUTPUT_BYTES
          ? next
          : `${Buffer.from(next).subarray(0, Math.max(0, MAX_OUTPUT_BYTES - 64)).toString('utf8')}\n… Results truncated`;
      };

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(drainTimer);
        clearTimeout(forceTimer);
        signal?.removeEventListener('abort', abortListener);
      };

      const finish = () => {
        if (settled || !exited) return;
        settled = true;
        cleanup();
        if (!stdoutEnded) child.stdout?.unref?.();
        if (!stderrEnded) child.stderr?.unref?.();
        if (signal?.aborted) {
          const err = new Error('Generation stopped');
          err.name = 'AbortError';
          return reject(err);
        }
        if (killedSignal && exitCode === null) {
          return reject(new Error(`Command terminated by ${killedSignal}${timedOut ? ' (timeout)' : ''}`));
        }
        resolvePromise({
          code: exitCode ?? 1,
          stdout,
          stderr,
          driverName: spawnSpec.driverName,
        });
      };

      const maybeFinish = () => {
        if (exited && stdoutEnded && stderrEnded) finish();
      };

      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
      child.stdout.once('end', () => { stdoutEnded = true; maybeFinish(); });
      child.stderr.once('end', () => { stderrEnded = true; maybeFinish(); });

      const terminate = (timeout = false) => {
        timedOut ||= timeout;
        try { child.kill('SIGTERM'); } catch {}
        forceTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
        forceTimer.unref?.();
      };

      const timer = setTimeout(() => terminate(true), timeoutMs);
      timer.unref?.();
      const abortListener = () => terminate(false);
      signal?.addEventListener('abort', abortListener, { once: true });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.once('exit', (code, signalName) => {
        if (settled) return;
        exited = true;
        exitCode = code;
        killedSignal = signalName;
        if (stdoutEnded && stderrEnded) return finish();
        drainTimer = setTimeout(finish, 250);
        drainTimer.unref?.();
      });
    });
  }
}

async function checkCommandAvailable(bin) {
  return new Promise((resolvePromise) => {
    const child = spawn('which', [bin], { stdio: 'ignore' });
    child.once('exit', (code) => resolvePromise(code === 0));
    child.once('error', () => resolvePromise(false));
  });
}
