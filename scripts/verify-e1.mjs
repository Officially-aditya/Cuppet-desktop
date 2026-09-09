import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');

const pkg = JSON.parse(await read('package.json'));
const contract = JSON.parse(await read('migration/e1-contract.json'));
const bootstrap = await read('src/main/bootstrap.mjs');
const runtimeClient = await read('src/main/runtime-client.mjs');
const credentials = await read('src/main/credential-storage.mjs');
const providerSettings = await read('src/main/provider-settings.mjs');
const localEmbedding = await read('src/runtime/pe3/local-embedding.mjs');
const smoke = await read('scripts/smoke-packaged-runtime.mjs');
const ci = await read('.github/workflows/ci.yml');
const docs = await read('docs/e1-production-packaging.md');
const runtimeFixture = await read('test-support/runtime-client-child.mjs');

assert.equal(contract.phase, 'E1');
assert.equal(contract.status, 'implemented-candidate');
for (const [name, value] of Object.entries(contract.requirements)) assert.equal(value, true, `E1 contract requirement is not pinned true: ${name}`);
assert.equal(contract.runtimeDependencies.npmProductionDependencies, 0);
assert.equal(contract.runtimeDependencies.pe3Embedding, 'cuppet/subword-hash-v1');
assert.equal(contract.runtimeDependencies.pe3ExternalModelDownload, false);
assert.equal(contract.runtimeDependencies.pe3NativeRuntimeDependency, false);
assert.equal(contract.tst.desktopProtocol, 'cuppet.tst.v3');
assert.equal(contract.tst.upstreamTstV03AutoBundled, false);

assert.equal(pkg.main, 'src/main/bootstrap.mjs');
assert.equal(pkg.build.appId, 'com.cuppet.desktop');
assert.equal(pkg.build.productName, 'Cuppet');
assert.equal(pkg.build.executableName, 'cuppet');
assert.equal(pkg.build.asar, true);
assert.equal(pkg.build.allowMissingDependencies, undefined);
assert.ok(pkg.build.files.includes('src/**/*'));
assert.deepEqual(pkg.dependencies, {});
assert.equal(pkg.build.asarUnpack, undefined);
assert.equal(pkg.devDependencies.electron, '44.3.0');
assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
assert.match(pkg.scripts['pack:dir'], /electron-builder --dir --publish never$/);
assert.equal(pkg.scripts['e1:audit-runtime'], 'npm audit --omit=dev --audit-level=high');
assert.equal(pkg.scripts['e1:package-smoke'], 'node scripts/smoke-packaged-runtime.mjs');
assert.equal(pkg.scripts['e1:verify'], 'node scripts/verify-e1.mjs');

for (const token of ['requestSingleInstanceLock', 'setWindowOpenHandler', 'setPermissionRequestHandler', 'setPermissionCheckHandler', 'will-navigate']) {
  assert.match(bootstrap, new RegExp(token), `production bootstrap missing ${token}`);
}
assert.match(bootstrap, /protocol === 'https:'/);
assert.match(runtimeClient, /ELECTRON_RUN_AS_NODE: '1'/);
assert.match(runtimeClient, /await mkdir\(this\.#dataDir/);
assert.match(runtimeClient, /child\.stdin\.end\(\)/);
assert.match(runtimeClient, /SIGTERM/);
assert.match(runtimeClient, /SIGKILL/);
assert.match(credentials, /basic_text/);
assert.match(credentials, /backend === 'unknown'/);
assert.match(providerSettings, /writeSettingsAtomically/);
assert.match(providerSettings, /mode: 0o600/);
assert.match(localEmbedding, /LocalFeatureEmbeddingProvider/);
assert.match(localEmbedding, /cuppet\/subword-hash-v1/);
assert.doesNotMatch(localEmbedding, /@huggingface|onnxruntime|sharp/i);
assert.match(runtimeFixture, /runtime\.ready/);
assert.match(runtimeFixture, /createInterface/);
await assert.rejects(access(join(root, 'test/fixtures/runtime-client-child.mjs')), { code: 'ENOENT' });
assert.match(smoke, /app\.asar/);
assert.match(smoke, /session\.create/);
assert.match(smoke, /session\.list/);
assert.match(smoke, /same data directory/);
assert.match(docs, /zero npm production dependencies/);
assert.match(docs, /cuppet\.tst\.v3/);
assert.match(docs, /does not expose the `cuppet\.tst\.v3` handshake/);
assert.match(ci, /actions\/checkout@v6/);
assert.match(ci, /actions\/setup-node@v6/);
assert.match(ci, /concurrency:/);
assert.match(ci, /github\.head_ref \|\| github\.ref_name/);
assert.match(ci, /cancel-in-progress: true/);
assert.ok((ci.match(/timeout-minutes:/g) ?? []).length >= 2);
assert.match(ci, /timeout-minutes: 20/);
assert.match(ci, /npm run e1:audit-runtime/);
assert.match(ci, /npm run e1:verify/);
assert.match(ci, /npm run pack:dir/);
assert.match(ci, /npm run e1:package-smoke/);

for (const path of ['src/main/bootstrap.mjs', 'src/main/credential-storage.mjs', 'src/main/runtime-client.mjs', 'src/runtime/pe3/local-embedding.mjs', 'test-support/runtime-client-child.mjs', 'scripts/smoke-packaged-runtime.mjs']) {
  run(process.execPath, ['--check', join(root, path)]);
}
run(process.execPath, ['--test', join(root, 'test/e1-packaging.test.mjs'), join(root, 'test/pe3-local-embedding.test.mjs')]);

console.log('E1 production packaging verification passed.');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
