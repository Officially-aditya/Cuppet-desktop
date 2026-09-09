#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [provider, auth, factory, toolRuntime, journaled, settings, presets, pkg] = await Promise.all([
  read('src/runtime/codex-provider.mjs'),
  read('src/main/codex-auth.mjs'),
  read('src/runtime/provider-factory.mjs'),
  read('src/runtime/tool-runtime.mjs'),
  read('src/runtime/journaled-tool-runtime.mjs'),
  read('src/renderer/settings-hub.js'),
  read('src/main/provider-presets.mjs'),
  read('package.json'),
]);

assert.match(provider, /parseCodexAccount/);
assert.match(provider, /dynamicTools/);
assert.match(provider, /item\/tool\/call/);
assert.match(provider, /approvalPolicy: 'never'/);
assert.match(provider, /sandbox: 'read-only'/);
assert.match(provider, /turn\/interrupt/);
assert.match(auth, /account\/login\/start/);
assert.match(auth, /type: 'chatgpt'/);
assert.match(auth, /account\/login\/completed/);
assert.match(auth, /shell\.openExternal/);
assert.doesNotMatch(auth, /auth\.json|access[_-]?token|refresh[_-]?token/i);
assert.match(factory, /CodexSubscriptionProvider/);
assert.match(toolRuntime, /executeTool/);
assert.match(journaled, /executeTool/);
assert.match(settings, /Continue with ChatGPT/);
assert.match(settings, /providerApiKeyField.*hidden/s);
assert.match(settings, /stopImmediatePropagation/);
assert.match(presets, /authType: 'chatgpt'/);

const packageJson = JSON.parse(pkg);
assert.equal(packageJson.scripts['e2:stage-codex'], 'node scripts/stage-codex-app-server.mjs');
assert.equal(packageJson.scripts['e2:package-smoke'], 'node scripts/smoke-packaged-codex.mjs');
assert.ok(packageJson.build.extraResources.some((item) => item.from === 'vendor/codex' && item.to === 'codex'));

const tested = spawnSync(process.execPath, ['--test', 'test/codex-app-server.test.mjs', 'test/codex-provider.test.mjs'], { stdio: 'inherit' });
if (tested.status !== 0) process.exit(tested.status ?? 1);
console.log('E2 Codex subscription provider verification passed.');

function read(path) { return readFile(path, 'utf8'); }
