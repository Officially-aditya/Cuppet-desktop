import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { codexRuntimeKey } from '../src/runtime/codex-app-server.mjs';

const RELEASE = 'rust-v0.171.0';
const VERSION = '0.171.0';
const ARTIFACTS = Object.freeze({
  'darwin-arm64': { asset: 'codex-app-server-package-aarch64-apple-darwin.tar.gz', sha256: 'fe53328d2aa683e33ecef412a04ffb798025f65d7a41be9b09ad91fe91794402' },
  'darwin-x64': { asset: 'codex-app-server-package-x86_64-apple-darwin.tar.gz', sha256: '047c0fbff055623590df793c5e31fca537299dea51132c1272f25698e439d512' },
  'linux-x64': { asset: 'codex-app-server-package-x86_64-unknown-linux-musl.tar.gz', sha256: 'fbb41f283b22a161905a3849354ce7b7dd70c553ae422451aef908220fcabc8e' },
  'linux-arm64': { asset: 'codex-app-server-package-aarch64-unknown-linux-musl.tar.gz', sha256: '73a7153f002d025db50fca0e11d43856bb726a732296818030ecb2e4a0cf0318' },
  'win32-x64': { asset: 'codex-app-server-package-x86_64-pc-windows-msvc.tar.gz', sha256: '9b20001daac4387f94315013382c6853e40c8f63de0603be021e4a5e983c329c' },
  'win32-arm64': { asset: 'codex-app-server-package-aarch64-pc-windows-msvc.tar.gz', sha256: '8a60e27c88bc567c8acab3338337b526e281bd08a76cf856f77a67b6a5e25a10' },
});

const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=') || true];
}));
const runtime = String(args.runtime || codexRuntimeKey());
const artifact = ARTIFACTS[runtime];
if (!artifact) throw new Error(`No pinned Codex app-server package for ${runtime || 'this platform'}`);

const stagingRoot = resolve(String(args.output || 'vendor/codex'));
const destination = join(stagingRoot, runtime);
const downloaded = args.archive ? resolve(String(args.archive)) : join(tmpdir(), `cuppet-${artifact.asset}`);
const temporary = join(tmpdir(), `cuppet-codex-stage-${process.pid}-${Date.now()}`);

try {
  if (!args.archive) await download(`https://github.com/openai/codex/releases/download/${RELEASE}/${artifact.asset}`, downloaded);
  const archive = await readFile(downloaded);
  const digest = sha256(archive);
  if (digest !== artifact.sha256) throw new Error(`Codex app-server package checksum mismatch for ${runtime}: expected ${artifact.sha256}, got ${digest}`);

  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', '-'], { cwd: temporary, input: archive, stdio: ['pipe', 'inherit', 'inherit'] });
  if (extracted.status !== 0) throw new Error(`Unable to extract ${artifact.asset}`);

  const packageRoot = await findPackageRoot(temporary, runtime);
  if (!packageRoot) throw new Error(`${artifact.asset} did not contain a complete Codex app-server package`);

  await rm(destination, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(packageRoot, destination, { recursive: true });

  const executableSuffix = runtime.startsWith('win32-') ? '.exe' : '';
  const target = join(destination, 'bin', `codex-app-server${executableSuffix}`);
  const codeModeHost = join(destination, 'bin', `codex-code-mode-host${executableSuffix}`);
  if (!runtime.startsWith('win32-')) {
    await chmod(target, 0o755);
    await chmod(codeModeHost, 0o755);
  }

  const packageManifest = JSON.parse(await readFile(join(destination, 'codex-package.json'), 'utf8'));
  if (packageManifest.version !== VERSION) throw new Error(`Codex package version mismatch: expected ${VERSION}, got ${packageManifest.version || 'unknown'}`);

  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    vendor: 'OpenAI',
    product: 'codex-app-server-package',
    version: VERSION,
    release: RELEASE,
    runtime,
    asset: artifact.asset,
    archiveSha256: artifact.sha256,
    requiredHelpers: ['codex-code-mode-host'],
    source: `https://github.com/openai/codex/releases/tag/${RELEASE}`,
  }, null, 2)}\n`, 'utf8');
  console.log(`Staged official Codex app-server package ${VERSION} for ${runtime} at ${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  if (!args.archive) await rm(downloaded, { force: true }).catch(() => undefined);
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Unable to download Codex app-server package (${response.status})`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

async function findPackageRoot(root, runtime) {
  const executableSuffix = runtime.startsWith('win32-') ? '.exe' : '';
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('codex-package.json')) {
      try {
        await access(join(directory, 'bin', `codex-app-server${executableSuffix}`));
        await access(join(directory, 'bin', `codex-code-mode-host${executableSuffix}`));
        return directory;
      } catch {}
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(join(directory, entry.name));
    }
  }
  return null;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
