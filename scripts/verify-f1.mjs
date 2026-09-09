import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_TST_SOURCE_REPOSITORY, MANAGED_TST_SOURCE_REVISION } from '../src/runtime/tst-release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const contract = JSON.parse(await read('migration/f1-contract.json'));
const supervisor = await read('src/runtime/tst-supervisor.mjs');
const runtimeManager = await read('src/runtime/runtime-tst-manager.mjs');
const runtimeMain = await read('src/runtime/main.mjs');
const runtimeClient = await read('src/main/runtime-client.mjs');
const stage = await read('scripts/stage-tst-runtime.mjs');
const verifyStage = await read('scripts/verify-staged-tst.mjs');
const smoke = await read('scripts/smoke-packaged-tst.mjs');
const ci = await read('.github/workflows/ci.yml');
const docs = await read('docs/f1-managed-tst-runtime.md');

assert.equal(contract.phase, 'F1');
assert.equal(contract.status, 'implemented-candidate');
for (const [name, value] of Object.entries(contract.requirements)) assert.equal(value, true, `F1 contract requirement is not pinned true: ${name}`);
assert.equal(contract.tst.protocol, 'cuppet.tst.v3');
assert.equal(contract.tst.sourceRepository, MANAGED_TST_SOURCE_REPOSITORY);
assert.equal(contract.tst.sourceRevision, MANAGED_TST_SOURCE_REVISION);
assert.equal(contract.tst.artifactKind, 'cuppet-tst-runtime');
assert.equal(contract.tst.packagedMode, 'managed-native-per-project');
assert.equal(contract.tst.windowsBundled, false);
assert.equal(contract.security.tokenBytes, 32);
assert.equal(contract.security.tokenPersisted, false);

assert.equal(pkg.scripts['f1:stage-tst'], 'node scripts/stage-tst-runtime.mjs');
assert.equal(pkg.scripts['f1:verify-staged-tst'], 'node scripts/verify-staged-tst.mjs');
assert.equal(pkg.scripts['f1:package-smoke'], 'node scripts/smoke-packaged-tst.mjs');
assert.equal(pkg.scripts['f1:verify'], 'node scripts/verify-f1.mjs');
assert.match(pkg.scripts['pack:dir'], /verify-staged-tst\.mjs/);
assert.ok(pkg.build.extraResources?.some((item) => item.from === 'vendor/tst' && item.to === 'tst'));
assert.deepEqual(pkg.dependencies, {});

for (const token of [
  "randomBytes(32).toString('hex')", "mode: 0o700", "bridge.call('shutdown')", "child.kill('SIGTERM')", "child.kill('SIGKILL')",
  'CUPPET_TST_SOCKET', 'CUPPET_TST_TOKEN', "spawn(this.#binaryPath", "resourcesPath ? join(resolve(resourcesPath), 'tst'",
]) assert.ok(supervisor.includes(token), `managed TST supervisor missing ${token}`);
assert.doesNotMatch(supervisor, /spawn\(['"]tst-daemon/);
assert.match(runtimeManager, /AsyncLocalStorage/);
assert.match(runtimeManager, /bindSession\(sessionId, current\.projectId, current\.projectRoot\)/);
assert.match(runtimeManager, /#closing/);
assert.match(runtimeMain, /new RuntimeTstManager/);
assert.match(runtimeMain, /tst\.runWithProject/);
assert.match(runtimeMain, /tst\.unregisterProject/);
assert.match(runtimeMain, /Promise\.all\(\[runtimeService\.close\(\), tst\.close\(\)\]\)/);
assert.match(runtimeClient, /CUPPET_RESOURCES_PATH: process\.resourcesPath/);

assert.match(stage, /kind !== 'cuppet-tst-runtime'/);
assert.match(stage, /MANAGED_TST_SOURCE_REVISION/);
assert.match(stage, /sourceMetadata\.files\[sourceBinaryRelative\]/);
assert.match(stage, /--protocol/);
assert.match(verifyStage, /source-tst-runtime\.json/);
assert.match(verifyStage, /sourceMetadata\.files\?\.\[sourceBinaryRelative\] !== digest/);
assert.match(smoke, /project-a/);
assert.match(smoke, /project-b/);
assert.match(smoke, /tst\.graph\.refresh/);
assert.match(smoke, /project-scoped memory must remain isolated/);
assert.match(smoke, /MANAGED_TST_SOURCE_REVISION/);
assert.match(smoke, /delete env\.CUPPET_TST_BIN/);
assert.match(smoke, /delete env\.CUPPET_TST_SOCKET/);
assert.match(smoke, /delete env\.CUPPET_TST_TOKEN/);

assert.match(ci, /Officially-aditya\/Cuppet-code/);
assert.ok(ci.includes(MANAGED_TST_SOURCE_REVISION), 'CI must pin the merged Cuppet-code F1A revision');
assert.match(ci, /cargo build --locked -p tst-daemon --release/);
assert.ok(ci.includes(`GITHUB_SHA=${MANAGED_TST_SOURCE_REVISION} node scripts/package-tst-runtime.mjs`), 'downstream packaging must stamp the pinned Cuppet-code source revision into the standalone artifact');
assert.match(ci, /npm run f1:stage-tst/);
assert.match(ci, /npm run f1:verify-staged-tst/);
assert.match(ci, /npm run f1:verify/);
assert.match(ci, /npm run f1:package-smoke/);
assert.match(docs, /managed native/i);
assert.ok(docs.includes(MANAGED_TST_SOURCE_REVISION));
assert.match(docs, /does not search `PATH`/);
assert.match(docs, /PE3/);

for (const path of [
  'src/runtime/tst-release.mjs',
  'src/runtime/tst-supervisor.mjs',
  'src/runtime/runtime-tst-manager.mjs',
  'src/runtime/main.mjs',
  'src/main/runtime-client.mjs',
  'scripts/stage-tst-runtime.mjs',
  'scripts/verify-staged-tst.mjs',
  'scripts/smoke-packaged-tst.mjs',
  'test/f1-runtime-tst-manager.test.mjs',
]) run(process.execPath, ['--check', join(root, path)]);
run(process.execPath, ['--test', join(root, 'test/f1-runtime-tst-manager.test.mjs'), join(root, 'test/runtime-process.test.mjs')]);

console.log('F1 managed native TST verification passed.');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
