import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { codexRuntimeKey } from '../src/runtime/codex-app-server.mjs';

const RELEASE = 'rust-v0.153.4';
const VERSION = '0.153.4';
const ARTIFACTS = Object.freeze({
  'darwin-arm64': { asset: 'codex-app-server-aarch64-apple-darwin.tar.gz', sha256: '1c68b24d3191fb7d5f57e1c15472fd87a5aa06c18160dd0430b21f10c6abe7f6' },
  'darwin-x64': { asset: 'codex-app-server-x86_64-apple-darwin.tar.gz', sha256: '1c7bcc3037d204305a81976227153250b58e546109b882649fee5420a14b7591' },
  'linux-x64': { asset: 'codex-app-server-x86_64-unknown-linux-musl.tar.gz', sha256: 'ace0e794c53d0c1abe2fdb9248684904d04b08aca5a7851bc4a7ce0887773cf0' },
  'linux-arm64': { asset: 'codex-app-server-aarch64-unknown-linux-musl.tar.gz', sha256: 'd2a3d0882f6eb4ddb84dfe1c90c5113dfbe32301f718706da0acd276770d3c75' },
});

const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=') || true];
}));
const runtime = String(args.runtime || codexRuntimeKey());
const artifact = ARTIFACTS[runtime];
if (!artifact) throw new Error(`No pinned Codex app-server artifact for ${runtime || 'this platform'}`);

const stagingRoot = resolve(String(args.output || 'staging/codex'));
const destination = join(stagingRoot, runtime);
const archive = args.archive ? resolve(String(args.archive)) : join(tmpdir(), `cuppet-${artifact.asset}`);
const temporary = join(tmpdir(), `cuppet-codex-stage-${process.pid}-${Date.now()}`);

try {
  if (!args.archive) await download(`https://github.com/openai/codex/releases/download/${RELEASE}/${artifact.asset}`, archive);
  const digest = sha256(await readFile(archive));
  if (digest !== artifact.sha256) throw new Error(`Codex app-server checksum mismatch for ${runtime}: expected ${artifact.sha256}, got ${digest}`);

  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error(`Unable to extract ${artifact.asset}`);
  const binary = await findBinary(temporary);
  if (!binary) throw new Error(`${artifact.asset} did not contain codex-app-server`);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const target = join(destination, process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server');
  await copyFile(binary, target);
  await chmod(target, 0o755);
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    vendor: 'OpenAI',
    product: 'codex-app-server',
    version: VERSION,
    release: RELEASE,
    runtime,
    asset: artifact.asset,
    archiveSha256: artifact.sha256,
    source: `https://github.com/openai/codex/releases/tag/${RELEASE}`,
  }, null, 2)}\n`, 'utf8');
  console.log(`Staged official Codex app-server ${VERSION} for ${runtime} at ${target}`);
} finally {
  await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  if (!args.archive) await rm(archive, { force: true }).catch(() => undefined);
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Unable to download Codex app-server (${response.status})`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}
async function findBinary(root) {
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && basename(entry.name).startsWith('codex-app-server')) return path;
    }
  }
  return null;
}
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
