import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const VERSION = 'agy_acp_server_1.1.1';
const MAX_ARCHIVE_BYTES = 800 * 1024 * 1024;
const MAX_SEARCH_ENTRIES = 256;
const MAX_SEARCH_DEPTH = 5;

const ASSETS = Object.freeze({
  'darwin-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
    'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
    316_014_828,
    'agy_acp_server.par', 802_163_856,
    'localharness_external', 116_766_704,
  ),
  'linux-x64': asset(
    'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
    '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
    681_969_407,
    'agy_acp_server.par', 1_880_360_328,
    'localharness_external', 128_966_920,
  ),
  'linux-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
    'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
    656_572_786,
    'agy_acp_server.par', 1_862_073_131,
    'localharness_external', 122_158_704,
  ),
  'win32-x64': asset(
    'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
    '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
    468_238_392,
    'agy_acp_server.exe', 430_801_616,
    'localharness_external.exe', 130_971_800,
  ),
  'win32-arm64': asset(
    'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
    '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
    468_521_191,
    'agy_acp_server.exe', 435_075_816,
    'localharness_external.exe', 122_455_704,
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
  const release = antigravityReleaseAsset(platform, arch);
  if (!release) throw new Error(`Google Antigravity ACP is not published for ${platform}-${arch}.`);
  const root = resolve(text(options.installRoot) || join(homedir(), '.cuppet', 'providers', 'antigravity'));
  const versionDirectory = join(root, VERSION, `${platform}-${arch}`);
  const existing = await validatedInstallation(versionDirectory, release, platform);
  if (existing) return existing;

  if (!installPromise) {
    installPromise = installRelease({ release, root, versionDirectory, platform, fetchImpl: options.fetchImpl ?? globalThis.fetch })
      .finally(() => { installPromise = null; });
  }
  return installPromise;
}

async function installRelease({ release, root, versionDirectory, platform, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('Antigravity ACP installation requires fetch().');
  await mkdir(dirname(versionDirectory), { recursive: true, mode: 0o700 });
  const working = await mkdtemp(join(root || tmpdir(), '.install-')).catch(async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(join(root, '.install-'));
  });
  const archivePath = join(working, 'antigravity-acp.zip');
  const extracted = join(working, 'extracted');
  try {
    await downloadVerifiedArchive(release, archivePath, fetchImpl);
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
    if (platform !== 'win32') {
      await chmod(executablePath, 0o755);
      await chmod(harnessPath, 0o755);
    }
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

async function downloadVerifiedArchive(release, destination, fetchImpl) {
  const response = await fetchImpl(release.url, { redirect: 'follow' });
  if (!response?.ok || !response.body) throw new Error(`Could not download Google Antigravity ACP (HTTP ${response?.status ?? 'unknown'}).`);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new Error('Antigravity ACP archive exceeds the allowed download size.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
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
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${psQuote(archivePath)}' -DestinationPath '${psQuote(destination)}' -Force`]);
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
