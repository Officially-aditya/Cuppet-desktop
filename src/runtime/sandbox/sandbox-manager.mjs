import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sanitizeEnvironment } from './env-sanitizer.mjs';
import { getMacSeatbeltSpawnSpec } from './mac-seatbelt-driver.mjs';
import { getLinuxBwrapSpawnSpec } from './linux-bwrap-driver.mjs';

const MAX_OUTPUT_BYTES = 128 * 1024;

export class SandboxManager {
  #platform;
  #seatbeltAvailable = null;
  #bwrapAvailable = null;
  #cacheRoot;
  #protectedPaths;

  constructor({ platform = process.platform, cacheRoot = join(homedir(), '.cache', 'cuppet-execution'), protectedPaths = [] } = {}) {
    this.#platform = platform;
    this.#cacheRoot = cacheRoot;
    this.#protectedPaths = protectedPaths;
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
        this.#bwrapAvailable = await stat('/usr/bin/bwrap').then((s) => s.isFile()).catch(() => false);
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
    const isFullAccess = Boolean(policy?.fullAccess || policy?.protectSensitiveCredentials === false);
    if (isFullAccess) {
      return { command, args: [], shell: true,
        env: sanitizeEnvironment(process.env, policy?.envOverrides, { fullAccess: true }),
        driverName: 'host-fallback' };
    }
    if (this.#platform === 'darwin' || this.#platform === 'linux') {
      if (!enabled || !(await this.isAvailable())) {
        throw new Error(`Protected command execution requires ${this.#platform === 'darwin' ? 'macOS sandbox-exec' : 'bubblewrap (bwrap) on Linux'}. No command was run.`);
      }
      policy = await this.#projectPolicy(policy);
    }
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

  async #projectPolicy(policy) {
    const root = await realpath(policy.projectRoot);
    const id = createHash('sha256').update(root).digest('hex');
    await mkdir(this.#cacheRoot, { recursive: true, mode: 0o700 });
    const cacheRoot = await realpath(this.#cacheRoot);
    const storage = join(cacheRoot, id);
    const names = ['tmp', 'npm', 'pnpm', 'yarn', 'electron', 'electron-builder', 'pip', 'uv', 'cargo', 'go-build', 'go-mod', 'gradle', 'xdg'];
    await Promise.all(names.map((name) => mkdir(join(storage, name), { recursive: true, mode: 0o700 })));
    for (const path of [storage, ...names.map((name) => join(storage, name))]) {
      if (await realpath(path) !== resolve(path)) throw new Error('Execution cache directories must not be symlinks.');
    }
    const identity = await gitIdentity(root);
    // Default and Auto commands use project-scoped caches and credential protection.
    return {
      ...policy, projectRoot: root, fullAccess: false, protectSensitiveCredentials: true,
      protectedPaths: [...this.#protectedPaths, ...(policy.protectedPaths ?? [])],
      scratchDirs: [...names.map((name) => join(storage, name)), ...(policy.scratchDirs ?? [])],
      envOverrides: {
        ...policy.envOverrides,
        ...identity,
        TMPDIR: join(storage, 'tmp'), TMP: join(storage, 'tmp'), TEMP: join(storage, 'tmp'),
        npm_config_cache: join(storage, 'npm'), npm_config_userconfig: '/dev/null',
        PNPM_HOME: join(storage, 'pnpm'), YARN_CACHE_FOLDER: join(storage, 'yarn'),
        ELECTRON_CACHE: join(storage, 'electron'), ELECTRON_BUILDER_CACHE: join(storage, 'electron-builder'),
        PIP_CACHE_DIR: join(storage, 'pip'), UV_CACHE_DIR: join(storage, 'uv'),
        CARGO_HOME: join(storage, 'cargo'), GOCACHE: join(storage, 'go-build'), GOMODCACHE: join(storage, 'go-mod'),
        GRADLE_USER_HOME: join(storage, 'gradle'), XDG_CACHE_HOME: join(storage, 'xdg'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
      },
    };
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
    if (signal?.aborted) { const error = new Error('Generation stopped'); error.name = 'AbortError'; throw error; }
    const realCwd = await realpath(cwd).catch(() => cwd);
    const spawnSpec = await this.getSpawnSpec(command, policy, { enabled });
    if (signal?.aborted) { const error = new Error('Generation stopped'); error.name = 'AbortError'; throw error; }

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

// Preserve ordinary commit identity without giving the shell the user's Git config.
async function gitIdentity(root) {
  const env = {};
  for (const path of [join(homedir(), '.gitconfig'), join(root, '.git', 'config')]) {
    const config = await readFile(path, 'utf8').catch(() => '');
    let user = false;
    for (const line of config.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) user = /^\s*\[user\]\s*$/i.test(line);
      const match = user && line.match(/^\s*(name|email)\s*=\s*(.*?)\s*$/i);
      if (!match) continue;
      const value = match[2].replace(/^"(.*)"$/, '$1');
      const key = match[1].toLowerCase() === 'name' ? 'NAME' : 'EMAIL';
      env[`GIT_AUTHOR_${key}`] = value;
      env[`GIT_COMMITTER_${key}`] = value;
    }
  }
  return env;
}
