#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { codexRuntimeKey } from '../src/runtime/codex-app-server.mjs';

const runtime = codexRuntimeKey();
assert.ok(runtime, `Codex app-server packaging is unsupported on ${process.platform}-${process.arch}`);
const root = resolve(argument('root') || 'vendor/codex');
const directory = join(root, runtime);
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = join(directory, 'bin', `codex-app-server${suffix}`);
const codeModeHost = join(directory, 'bin', `codex-code-mode-host${suffix}`);
const packageManifestPath = join(directory, 'codex-package.json');
const manifestPath = join(directory, 'manifest.json');
const accessMode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;

await access(binary, accessMode);
await access(codeModeHost, accessMode);
for (const [path, label] of [[binary, 'Codex app-server'], [codeModeHost, 'Codex code-mode host']]) {
  const itemStat = await stat(path);
  assert.ok(itemStat.isFile(), `staged ${label} must be a file`);
  assert.ok(itemStat.size > 1_000_000, `staged ${label} is unexpectedly small`);
}
const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
assert.equal(packageManifest.version, '0.153.4');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.vendor, 'OpenAI');
assert.equal(manifest.product, 'codex-app-server-package');
assert.equal(manifest.version, '0.153.4');
assert.equal(manifest.release, 'rust-v0.153.4');
assert.equal(manifest.runtime, runtime);
assert.match(manifest.asset, /^codex-app-server-package-/);
assert.deepEqual(manifest.requiredHelpers, ['codex-code-mode-host']);
assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);
assert.equal(manifest.source, 'https://github.com/openai/codex/releases/tag/rust-v0.153.4');
await run(binary, ['--help'], 8_000);
console.log(`Verified staged official Codex app-server package for ${runtime}: ${binary} + ${codeModeHost}`);

function argument(name) { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function run(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('Codex app-server probe timed out')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolveRun() : rejectRun(new Error(`Codex app-server --help exited ${code}: ${stderr}`)); });
  });
}
