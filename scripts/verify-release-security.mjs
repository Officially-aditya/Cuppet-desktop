import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const releaseConfig = JSON.parse(await read('build/electron-builder.release.json'));
const entitlements = await read('build/entitlements.mac.plist');
const inheritedEntitlements = await read('build/entitlements.mac.inherit.plist');
const workflow = await read('.github/workflows/release.yml');
const bootstrap = await read('src/main/bootstrap.mjs');
const updater = await read('src/main/auto-update.mjs');
const policy = await read('src/main/auto-update-policy.mjs');
const feedBuilder = await read('scripts/build-macos-update-feed.mjs');

assert.deepEqual(pkg.dependencies, {}, 'release hardening must not add production npm dependencies');
for (const key of ['appId', 'productName', 'executableName', 'asar', 'asarUnpack', 'files', 'extraResources', 'directories']) {
  assert.deepEqual(releaseConfig[key], pkg.build[key], `release config drifted from base packaging: ${key}`);
}
assert.equal(releaseConfig.forceCodeSigning, true, 'production release must fail if signing is unavailable');
assert.equal(releaseConfig.artifactName, '${productName}-${version}-${arch}.${ext}');
assert.equal(releaseConfig.mac.hardenedRuntime, true);
assert.equal(releaseConfig.mac.notarize, true);
assert.equal(releaseConfig.mac.entitlements, 'build/entitlements.mac.plist');
assert.equal(releaseConfig.mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist');
assert.deepEqual(releaseConfig.mac.target, ['dmg', 'zip']);
const publisher = releaseConfig.publish?.[0];
assert.deepEqual({ provider: publisher?.provider, owner: publisher?.owner, repo: publisher?.repo, tagNamePrefix: publisher?.tagNamePrefix }, { provider: 'github', owner: 'Officially-aditya', repo: 'Cuppet-desktop', tagNamePrefix: 'v' });
assert.equal(publisher?.publishAutoUpdate, false, 'release workflow owns publication explicitly');

for (const source of [entitlements, inheritedEntitlements]) {
  assert.match(source, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(source, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.doesNotMatch(source, /get-task-allow|disable-library-validation|allow-dyld-environment-variables|app-sandbox/);
}

for (const token of ['installMacAutoUpdater', 'auto-update.mjs', 'app.whenReady()']) assert.match(bootstrap, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(updater, /serverType:\s*'json'/);
assert.match(updater, /checkForUpdates\(\)/);
assert.doesNotMatch(updater, /quitAndInstall\(/, 'updates must never force an unexpected restart');
assert.match(policy, /update-feed\/macos\/arm64\/releases\.json/);
assert.match(policy, /prerelease-or-invalid-version/);
assert.match(feedBuilder, /sha256/);
assert.match(feedBuilder, /metadata\.size/);
assert.match(feedBuilder, /Release tag must exactly match/);

assert.match(workflow, /name:\s*Production Release/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
assert.match(workflow, /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*write/);
for (const secret of ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_API_KEY_P8_BASE64', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) assert.match(workflow, new RegExp(`secrets\\.${secret}`));
for (const command of ['npm run release:verify', 'npm run release:mac', 'codesign --verify', 'spctl --assess', 'xcrun stapler validate', 'npm run release:feed', 'gh release', 'update-feed']) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(workflow, /Provider V2 Selected/);
assert.match(workflow, /packaged-runtime-smoke|CI/);
assert.match(workflow, /PRERELEASE.*true|PRERELEASE.*false/s);
assert.match(workflow, /if \[\[ "\$PRERELEASE" == "false" \]\]/, 'only stable releases may advance the production update feed');

for (const path of ['src/main/auto-update-policy.mjs', 'src/main/auto-update.mjs', 'scripts/build-macos-update-feed.mjs', 'scripts/verify-release-security.mjs']) {
  const result = spawnSync(process.execPath, ['--check', join(root, path)], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const tests = spawnSync(process.execPath, ['--test', join(root, 'test/release-security.test.mjs')], { cwd: root, stdio: 'inherit' });
if (tests.status !== 0) process.exit(tests.status ?? 1);
console.log('Production release security verification passed: signing/notarization fail closed and stable macOS updates are hash-bound to signed release ZIPs.');
