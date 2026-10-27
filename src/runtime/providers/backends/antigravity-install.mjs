import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { detectLocalProviderApp, resolveLocalCliExecutable, resolveWindowsPowerShell } from '../../local-cli-environment.mjs';

const VERSION = '1.4.0';
const MAX_ARCHIVE_BYTES = 800 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 256;
const MAX_SEARCH_DEPTH = 5;

const ASSETS = Object.freeze({
  'darwin-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-darwin-arm64.zip',
    '21a32eeab85b394a515510c84539bda4b2504bf2917e0a201f5c4130b13581a5',
    112_734_313,
    'agy_acp_server.par', 280_980_064,
    'localharness_external', 120_246_928,
  ),
  'linux-x64': asset(
    'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip',
    'fbb2d54dd94fb897845308d3b6b46187c627f1c60078ded81adeeaf8b90c5d7a',
    336_175_910,
    'agy_acp_server.par', 930_814_465,
    'localharness_external', 131_187_512,
  ),
  'linux-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-arm64.zip',
    '3dc43a21f5402b23a4dba7b320a6745e9dbf4b6ead912ce9fc76011ea3a08a7e',
    321_912_925,
    'agy_acp_server.par', 933_404_508,
    'localharness_external', 124_895_000,
  ),
  'win32-x64': asset(
    'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip',
    'd737aad2d6388e071bc907db415c129a256915d275f436e68f10dcdf6af896da',
    125_646_049,
    'agy_acp_server.exe', 82_245_832,
    'localharness_external.exe', 146_036_888,
  ),
  'win32-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-arm64.zip',
    '37fac14835f06caf05b4b93fed59a0e16e7c716e3ec95f03d4779a61abe3c2e6',
    126_083_066,
    'agy_acp_server.exe', 86_867_784,
    'localharness_external.exe', 136_970_904,
  ),
});

let installPromise = null;

export function antigravityReleaseAsset(platform = process.platform, arch = process.arch) {
  const item = ASSETS[`${platform}-${arch}`];
  return item ? { ...item, executable: { ...item.executable }, harness: { ...item.harness } } : null;
}

export async function resolveAntigravityAcpInstallation(configuration = {}, options = {}) {
  const overrideCommand = text(configuration.antigravityAcpCommand || process.env.CUPPET_ANTIGRAVITY_ACP_BIN);
  const overrideHarness = text(configuration.antigravityHarnessPath || process.env.CUPPET_ANTIGRAVITY_HARNESS_PATH);
  if (overrideCommand || overrideHarness) {
    if (!overrideCommand || !overrideHarness) throw new Error('Antigravity ACP override requires both the ACP executable and local harness paths.');
    if (!await isFile(overrideCommand) || !await isFile(overrideHarness)) throw new Error('Antigravity ACP override executable or harness was not found.');
    return {
      command: overrideCommand,
      harnessPath: overrideHarness,
      args: Array.isArray(configuration.antigravityAcpArgs) ? configuration.antigravityAcpArgs.map(String) : [],
      version: 'override',
      source: 'override',
    };
  }

  const platform = text(options.platform) || process.platform;
  const arch = text(options.arch) || process.arch;
  const executableName = platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';
  const harnessName = platform === 'win32' ? 'localharness_external.exe' : 'localharness_external';
  const externalCommand = resolveLocalCliExecutable(executableName, process.env, { platform });
  if (externalCommand !== executableName && await isFile(externalCommand)) {
    const harnessPath = join(dirname(externalCommand), harnessName);
    if (await isFile(harnessPath)) return externalInstallation(externalCommand, harnessPath, platform);
  }
  const app = detectLocalProviderApp('antigravity', process.env, { platform });
  for (const directory of options.appDirectories ?? (app ? [app.path] : [])) {
    const command = await findNamedFile(directory, executableName).catch(() => null);
    if (!command) continue;
    const harnessPath = join(dirname(command), harnessName);
    if (await isFile(harnessPath)) return externalInstallation(command, harnessPath, platform);
  }
  const release = antigravityReleaseAsset(platform, arch);
  if (!release && options.allowInstall === false) return null;
  if (!release) throw new Error(`Google Antigravity ACP is not published for ${platform}-${arch}.`);
  const root = resolve(text(options.installRoot) || join(homedir(), '.cuppet', 'providers', 'antigravity'));
  const versionDirectory = join(root, VERSION, `${platform}-${arch}`);
  const existing = await validatedInstallation(versionDirectory, release, platform);
  if (existing) return existing;
  if (options.allowInstall === false) return null;

  if (!installPromise) {
    installPromise = installRelease({ release, root, versionDirectory, platform, fetchImpl: options.fetchImpl ?? globalThis.fetch, signal: options.signal })
      .finally(() => { installPromise = null; });
  }
  return installPromise;
}

async function installRelease({ release, root, versionDirectory, platform, fetchImpl, signal }) {
  if (typeof fetchImpl !== 'function') throw new Error('Antigravity ACP installation requires fetch().');
  await mkdir(dirname(versionDirectory), { recursive: true, mode: 0o700 });
  const working = await mkdtemp(join(root || tmpdir(), '.install-')).catch(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(join(root, '.install-'));
  });
  const archivePath = join(working, 'antigravity-acp.zip');
  const extracted = join(working, 'extracted');
  try {
    await downloadVerifiedArchive(release, archivePath, fetchImpl, signal);
    signal?.throwIfAborted();
    await mkdir(extracted, { recursive: true, mode: 0o700 });
    await extractArchive(archivePath, extracted, platform);
    const executablePath = await findNamedFile(extracted, release.executable.name);
    const harnessPath = await findNamedFile(extracted, release.harness.name);
    if (!executablePath || !harnessPath) throw new Error('Verified Antigravity archive did not contain the expected ACP executable and harness.');
    await verifyFile(executablePath, release.executable.bytes, release.executable.name);
    await verifyFile(harnessPath, release.harness.bytes, release.harness.name);
    if (platform !== 'win32') {
      await chmod(executablePath, 0o755);
      await chmod(harnessPath, 0o755);
    }

    const staged = join(working, 'release');
    await mkdir(staged, { recursive: true, mode: 0o700 });
    const stagedExecutable = join(staged, release.executable.name);
    const stagedHarness = join(staged, release.harness.name);
    await rename(executablePath, stagedExecutable);
    await rename(harnessPath, stagedHarness);
    await rm(versionDirectory, { recursive: true, force: true });
    await mkdir(dirname(versionDirectory), { recursive: true, mode: 0o700 });
    await rename(staged, versionDirectory);
    const installed = await validatedInstallation(versionDirectory, release, platform);
    if (!installed) throw new Error('Antigravity ACP installation failed post-install verification.');
    return installed;
  } finally {
    await rm(working, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function validatedInstallation(directory, release, platform) {
  const executablePath = join(directory, release.executable.name);
  const harnessPath = join(directory, release.harness.name);
  try {
    await verifyFile(executablePath, release.executable.bytes, release.executable.name);
    await verifyFile(harnessPath, release.harness.bytes, release.harness.name);
    return {
      command: executablePath,
      harnessPath,
      args: platform === 'linux' ? ['--uid='] : [],
      version: VERSION,
      source: 'managed',
    };
  } catch {
    return null;
  }
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true;
}

function externalInstallation(command, harnessPath, platform) {
  return { command, harnessPath, args: platform === 'linux' ? ['--uid='] : [], version: null, source: 'native' };
}

async function downloadVerifiedArchive(release, destination, fetchImpl, signal) {
  const response = await fetchImpl(release.url, { redirect: 'follow', signal });
  if (!response?.ok || !response.body) throw new Error(`Could not download Google Antigravity ACP (HTTP ${response?.status ?? 'unknown'}).`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new Error('Antigravity ACP archive exceeds the allowed download size.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  const archiveStat = await stat(destination);
  if (archiveStat.size !== release.archiveBytes) throw new Error(`Antigravity ACP archive size mismatch: expected ${release.archiveBytes}, received ${archiveStat.size}.`);
  const digest = await sha256File(destination);
  if (digest !== release.sha256) throw new Error('Antigravity ACP archive checksum verification failed.');
}

async function extractArchive(archivePath, destination, platform) {
  if (platform === 'darwin') {
    await runProcess('/usr/bin/ditto', ['-x', '-k', archivePath, destination]);
    return;
  }
  if (platform === 'win32') {
    const psCmd = resolveWindowsPowerShell(platform);
    await runProcess(psCmd, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${psQuote(archivePath)}' -DestinationPath '${psQuote(destination)}' -Force`]);
    return;
  }
  await runProcess('unzip', ['-q', archivePath, '-d', destination]);
}

async function findNamedFile(root, name) {
  let visited = 0;
  const walk = async (directory, depth) => {
    if (depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_ENTRIES) return null;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > MAX_SEARCH_ENTRIES) return null;
      const path = join(directory, entry.name);
      if (entry.isFile() && basename(path) === name) return path;
      if (entry.isDirectory()) {
        const nested = await walk(path, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(root, 0);
}

async function verifyFile(path, expectedBytes, label) {
  const file = await stat(path);
  if (!file.isFile() || file.size !== expectedBytes) throw new Error(`${label} failed verified-size validation.`);
}

function runProcess(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once('error', rejectRun);
    child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} failed with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`)));
  });
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', rejectHash);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function asset(url, sha256, archiveBytes, executableName, executableBytes, harnessName, harnessBytes) {
  return Object.freeze({
    version: VERSION,
    url,
    sha256,
    archiveBytes,
    executable: Object.freeze({ name: executableName, bytes: executableBytes }),
    harness: Object.freeze({ name: harnessName, bytes: harnessBytes }),
  });
}
function psQuote(value) { return String(value).replaceAll("'", "''"); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
