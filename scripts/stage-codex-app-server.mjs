import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { codexRuntimeKey } from '../src/runtime/codex-app-server.mjs';

const RELEASE = 'rust-v0.162.1';
const VERSION = '0.162.1';
const ARTIFACTS = Object.freeze({
  'darwin-arm64': { asset: 'codex-app-server-package-aarch64-apple-darwin.tar.gz', sha256: '28c0e2fbfb39a422dcfdd5bb87027a12242da7fa2dc997811bc0a6d2316c4f93' },
  'darwin-x64': { asset: 'codex-app-server-package-x86_64-apple-darwin.tar.gz', sha256: 'b0bacdc1efa7cccf849c1435fd9b5de729f1f4f174eb0a742ce0f47ab42078ee' },
  'linux-x64': { asset: 'codex-app-server-package-x86_64-unknown-linux-musl.tar.gz', sha256: '8748f9f8b708b3bc5a52b3f0a1ccddb22e6985f0efb4f45dafa1677e324abe0e' },
  'linux-arm64': { asset: 'codex-app-server-package-aarch64-unknown-linux-musl.tar.gz', sha256: '0531a9250a968feb8597c4a3b43da0694b04333896fd6cd1e1c7d31702d159ec' },
  'win32-x64': { asset: 'codex-app-server-package-x86_64-pc-windows-msvc.tar.gz', sha256: 'e67c01033b79e7ee3ec763b85cf5c7b774ba4846d46c0b0920193bd19f835728' },
  'win32-arm64': { asset: 'codex-app-server-package-aarch64-pc-windows-msvc.tar.gz', sha256: 'f2f19e6dfcdb6adbbf59cc9864782edd85c87ffe500fa9d90b02636ee919649c' },
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
