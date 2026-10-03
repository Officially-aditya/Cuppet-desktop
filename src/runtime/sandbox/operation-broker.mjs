import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { sanitizeEnvironment } from './env-sanitizer.mjs';

const exec = promisify(execFile);
const GIT = '/usr/bin/git';
const GIT_OPTIONS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

// Only these structured operations leave the command sandbox. Agent commands and
// repository hooks never run in the credential-bearing host process.
export class OperationBroker {
  #sandbox; #root; #platform; #host;
  constructor({ sandbox, dataDir = join(homedir(), '.cuppet-desktop'), platform = process.platform, hostRunner = runHost }) {
    this.#sandbox = sandbox;
    this.#root = join(dataDir, 'operation-broker');
    this.#platform = platform;
    this.#host = hostRunner;
  }

  async gitPush({ projectRoot, remote = 'origin', branch, commit, authorize, signal }) {
    this.#requireUnix();
    const root = await realpath(projectRoot);
    await this.#requirePrivateStorage(root);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)) throw new Error('A configured remote name is required.');
    if (!validBranch(branch)) throw new Error('A valid destination branch is required.');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? '')) throw new Error('Supply the full commit hash to push.');
    const head = await this.#git(root, ['rev-parse', '--verify', 'HEAD'], signal);
    if (head !== commit) throw new Error('git_push only pushes the exact current HEAD commit.');
    const urls = (await this.#git(root, ['remote', 'get-url', '--push', '--all', remote], signal)).split('\n');
    if (urls.length !== 1 || !validRemoteUrl(urls[0])) throw new Error('Push requires one HTTPS or SSH remote without embedded passwords/tokens.');
    const url = urls[0];
    await authorize({ action: 'git-push', resources: [root, remote, url, branch, commit],
      fingerprintKey: digest({ root, remote, url, branch, commit }),
      description: `Push ${commit} to ${remote}/${branch} (${url})` });
    if (signal?.aborted) throw signal.reason ?? new Error('Operation stopped');

    return this.#job(async (job) => {
      const exported = join(job, 'export');
      await mkdir(exported);
      const bundle = join(job, 'commit.bundle');
      const exportedBundle = join(exported, 'commit.bundle');
      await this.#sandboxCommand(root, [GIT, ...GIT_OPTIONS, 'bundle', 'create', exportedBundle, 'HEAD'], signal, exported);
      // Source subprocesses retain access only to export/, never the snapshot,
      // private repository or credential-bearing process used after this copy.
      await copyFile(exportedBundle, bundle);
      const env = hostEnvironment(false);
      const advertised = await this.#host(GIT, [...GIT_OPTIONS, 'bundle', 'list-heads', bundle, 'HEAD'], job, env, signal);
      if (advertised.stdout.trim() !== `${commit} HEAD`) throw new Error('HEAD changed while preparing push; request approval again for the new commit.');
      const repo = join(job, 'repo.git');
      await this.#host(GIT, [...GIT_OPTIONS, 'clone', '--bare', '--no-local', '--template=', bundle, repo], job, env, signal);

      // Read only trusted user credential configuration, outside the source repo.
      // Global URL rewrites and repository-configured helpers cannot redirect push.
      const helpers = await credentialHelpers(url, job, signal, this.#host, root);
      const auth = hostEnvironment(true);
      const args = [...GIT_OPTIONS, '-C', repo, '-c', 'http.followRedirects=false', '-c', 'credential.helper=',
        ...helpers.flatMap((helper) => ['-c', `credential.helper=${helper}`]),
        'push', '--porcelain', '--no-verify',
        '--no-follow-tags', '--recurse-submodules=no', url, `${commit}:refs/heads/${branch}`];
      const result = await this.#host(GIT, args, job, auth, signal);
      let trackingWarning = '';
      try {
        await this.#git(root, ['update-ref', `refs/remotes/${remote}/${branch}`, commit], signal);
      } catch {
        trackingWarning = '\nPush succeeded, but the local tracking ref could not be updated; refresh the repository from its remote.';
      }
      return { output: `Pushed ${commit} to ${remote}/${branch}.\n${result.stdout.trim()}${trackingWarning}`, paths: [], mutation: false };
    });
  }

  async packageDmg({ projectRoot, source, output, authorize, signal }) {
    if (this.#platform !== 'darwin') throw new Error('package_dmg is available only on macOS.');
    const root = await realpath(projectRoot);
    await this.#requirePrivateStorage(root);
    const app = await workspacePath(root, source, true);
    if (!app.endsWith('.app') || !(await stat(app)).isDirectory()) throw new Error('source must be a project .app directory.');
    const destination = await workspacePath(root, output, false);
    if (!destination.endsWith('.dmg')) throw new Error('output must be a project .dmg path.');
    await authorize({ action: 'package-dmg', resources: [root, app, destination],
      fingerprintKey: digest({ root, app, destination }), description: `Create ${relative(root, destination)} from ${relative(root, app)}` });
    return this.#job(async (job) => {
      const stage = join(job, 'stage');
      await mkdir(stage);
      await this.#sandboxCommand(root, ['/bin/cp', '-R', '-P', app, join(stage, basename(app))], signal, stage);
      await validateStagedLinks(stage);
      const image = join(job, 'artifact.dmg');
      const volume = `Cuppet-${randomUUID().slice(0, 8)}`;
      await this.#host('/usr/bin/hdiutil', ['create', '-srcfolder', stage, '-format', 'UDZO', '-volname', volume, image], job, hostEnvironment(false), signal);
      await this.#host('/usr/bin/hdiutil', ['verify', image], job, hostEnvironment(false), signal);
      // The final write is sandboxed too, including resolution of output symlinks.
      await this.#sandboxCommand(root, ['/bin/cp', image, destination], signal, job);
      return { output: `Created ${relative(root, destination)} (${(await stat(image)).size} bytes).`, paths: [relative(root, destination)], mutation: true };
    });
  }

  async #git(root, args, signal) {
    return (await this.#sandboxCommand(root, [GIT, ...GIT_OPTIONS, ...args], signal)).stdout.trim();
  }
  async #sandboxCommand(root, argv, signal, job = null) {
    const result = await this.#sandbox.execute(argv.map(quote).join(' '), root, {
      projectRoot: root, scratchDirs: job ? [job] : [], brokerJobDirs: job ? [job] : [],
      protectedPaths: [this.#root],
    }, { signal, timeoutMs: 120000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Operation preparation failed.');
    return result;
  }
  async #job(fn) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const job = await realpath(await mkdtemp(join(this.#root, 'job-')));
    try { return await fn(job); }
    finally { await rm(job, { recursive: true, force: true }); }
  }
  #requireUnix() {
    if (!['darwin', 'linux'].includes(this.#platform)) throw new Error('The operation broker is available only on Mac/Linux.');
  }
  async #requirePrivateStorage(projectRoot) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    this.#root = await realpath(this.#root);
    if (inside(projectRoot, this.#root)) throw new Error('Operation broker storage must be outside the active project.');
  }
}

function hostEnvironment(credentials) {
  return { ...sanitizeEnvironment(process.env, {}, { fullAccess: credentials }),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -o BatchMode=yes',
    ...(credentials && process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
    ...(credentials && process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  };
}
async function credentialHelpers(url, cwd, signal, host, projectRoot) {
  if (!url.startsWith('https://')) return [];
  const env = { ...hostEnvironment(false) };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.GIT_CONFIG_NOSYSTEM;
  try {
    const result = await host(GIT, ['config', '--get-urlmatch', 'credential.helper', url], cwd, env, signal);
    const helpers = result.stdout.trim().split('\n').filter(Boolean);
    if (helpers.some((helper) => !/^(?:osxkeychain|libsecret|manager|manager-core|cache|store)$/.test(helper))) {
      throw new Error('Authenticated push requires a standard Git credential helper (osxkeychain, libsecret, manager, cache or store). Shell/custom helpers are not executed by the broker.');
    }
    if (!helpers.length) return [];
    const execPath = (await host(GIT, ['--exec-path'], cwd, hostEnvironment(false), signal)).stdout.trim();
    const programs = [];
    for (const helper of helpers) {
      let program = null;
      for (const dir of [execPath, ...hostEnvironment(false).PATH.split(':')]) {
        if (!isAbsolute(dir)) continue;
        const candidate = await realpath(join(dir, `git-credential-${helper}`)).catch(() => null);
        if (!candidate) continue;
        if (inside(projectRoot, candidate) || inside(join(homedir(), '.cache', 'cuppet-execution'), candidate)) {
          throw new Error('Credential helper must be installed outside the project and command caches.');
        }
        if ((await stat(candidate)).isFile()) { program = candidate; break; }
      }
      if (!program) throw new Error(`Git credential helper ${helper} is not installed in a trusted tool directory.`);
      // Git treats an absolute helper as a program; escape its path for Git's
      // internal shell without allowing project PATH entries to choose it.
      programs.push(program.replace(/[^A-Za-z0-9/_.,:+-]/g, (character) => `\\${character}`));
    }
    return programs;
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}
async function runHost(command, args, cwd, env, signal) {
  return exec(command, args, { cwd, env, signal, timeout: 120000, maxBuffer: 128 * 1024 });
}
export function validRemoteUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  if (/^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return !value.includes('..');
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && Boolean(url.hostname) && !url.password
      && (url.protocol !== 'https:' || !url.username) && !url.search && !url.hash
      && url.pathname.length > 1 && !url.pathname.includes('..');
  } catch { return false; }
}
function validBranch(value) {
  return typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !/\.\.|\/\/|\/\.|\.lock(?:\/|$)|[./]$/.test(value);
}
async function workspacePath(root, value, exists) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('A workspace path is required.');
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error('Operation paths must stay inside the active project.');
  const physical = exists ? await realpath(path) : join(await realpath(dirname(path)), basename(path));
  if (!inside(root, physical)) throw new Error('Operation paths must not escape the project through a symlink.');
  if (!exists && await lstat(path).then((s) => s.isSymbolicLink()).catch(() => false)) throw new Error('Output must not be a symlink.');
  return physical;
}
export async function validateStagedLinks(dir, root = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(path);
      const target = await realpath(path).catch(() => resolve(dir, link));
      if (isAbsolute(link) || !inside(root, target)) throw new Error('The app contains a symlink that escapes its staging directory.');
    } else if (entry.isDirectory()) await validateStagedLinks(path, root);
  }
}
function inside(root, path) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
