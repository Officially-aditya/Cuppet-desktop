import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, codexRuntimeKey, resolveCodexAppServerCommand } from '../src/runtime/codex-app-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] || defaultExecutable(root));
const resources = resourcesDirectory(executable);
const runtime = codexRuntimeKey();
assert.ok(runtime, `Codex app-server packaging is unsupported on ${process.platform}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';
const packageRoot = join(resources, 'codex', runtime);
const binary = join(packageRoot, 'bin', `codex-app-server${suffix}`);
const codeModeHost = join(packageRoot, 'bin', `codex-code-mode-host${suffix}`);
const packageManifestPath = join(packageRoot, 'codex-package.json');
const manifestPath = join(packageRoot, 'manifest.json');

await access(executable);
await access(binary);
await access(codeModeHost);
const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
assert.equal(packageManifest.version, '0.153.4');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.vendor, 'OpenAI');
assert.equal(manifest.product, 'codex-app-server-package');
assert.equal(manifest.version, '0.153.4');
assert.equal(manifest.runtime, runtime);
assert.deepEqual(manifest.requiredHelpers, ['codex-code-mode-host']);

const resolved = await resolveCodexAppServerCommand({ resourcesPath: resources, env: {}, platform: process.platform, arch: process.arch });
assert.equal(resolved?.source, 'packaged');
assert.equal(resolved?.command, binary, 'packaged Codex resolver must use the canonical package entrypoint only when its code-mode host exists');

const client = new CodexAppServerClient({ command: binary, args: [], env: process.env });
try {
  await client.start();
  const account = await client.request('account/read', {}, 10_000);
  assert.ok(account && typeof account === 'object', 'packaged Codex account/read must return an object');
  console.log(`E2 packaged Codex app-server smoke passed with code-mode host: ${binary}`);
} finally {
  await client.close();
}

function defaultExecutable(projectRoot) {
  if (process.platform === 'win32') return join(projectRoot, 'dist', 'win-unpacked', 'cuppet.exe');
  if (process.platform === 'darwin') return join(projectRoot, 'dist', 'mac', 'Cuppet.app', 'Contents', 'MacOS', 'cuppet');
  return join(projectRoot, 'dist', 'linux-unpacked', 'cuppet');
}
function resourcesDirectory(executablePath) { return process.platform === 'darwin' ? resolve(dirname(executablePath), '..', 'Resources') : join(dirname(executablePath), 'resources'); }
