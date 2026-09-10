#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [provider, auth, factory, toolRuntime, journaled, settings, presets, pkg, stageCodex, appServer] = await Promise.all([
  read('src/runtime/codex-provider.mjs'),
  read('src/main/codex-auth.mjs'),
  read('src/runtime/provider-factory.mjs'),
  read('src/runtime/tool-runtime.mjs'),
  read('src/runtime/journaled-tool-runtime.mjs'),
  read('src/renderer/react/SettingsModal.tsx'),
  read('src/main/provider-presets.mjs'),
  read('package.json'),
  read('scripts/stage-codex-app-server.mjs'),
  read('src/runtime/codex-app-server.mjs'),
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
assert.match(settings, /window\.cuppet\.codexAuth\.login\(\)/, 'React settings surface does not start Codex-owned OAuth');
assert.match(settings, /window\.cuppet\.codexAuth\.logout\(\)/, 'React settings surface does not expose Codex sign-out');
assert.match(settings, /apiKey:\s*isCodex\s*\?\s*''\s*:\s*apiKey/, 'Codex provider must not persist a Cuppet-owned API key');
assert.match(settings, /isCodex\s*\?\s*\(/, 'React provider form does not branch to the Codex subscription surface');
assert.doesNotMatch(settings, /provider-base-url|provider-model|primary-effort/, 'advanced provider internals returned to the React settings surface');
assert.match(presets, /authType: 'chatgpt'/);
assert.match(stageCodex, /codex-app-server-package-aarch64-apple-darwin\.tar\.gz/, 'Codex staging returned to the incomplete standalone app-server artifact');
assert.match(stageCodex, /codex-code-mode-host/, 'Codex staging does not require the code-mode host');
assert.match(stageCodex, /codex-package\.json/, 'Codex staging does not preserve the official package layout');
assert.match(appServer, /join\(packageRoot, 'bin', executable\)/, 'packaged Codex resolver does not use the canonical package entrypoint');
assert.match(appServer, /executableFile\(candidate\.helper\)/, 'packaged Codex resolver can accept a package without code-mode host');

const packageJson = JSON.parse(pkg);
assert.equal(packageJson.scripts['e2:stage-codex'], 'node scripts/stage-codex-app-server.mjs');
assert.equal(packageJson.scripts['e2:package-smoke'], 'node scripts/smoke-packaged-codex.mjs');
assert.ok(packageJson.build.extraResources.some((item) => item.from === 'vendor/codex' && item.to === 'codex'));

const tested = spawnSync(process.execPath, ['--test', 'test/codex-app-server.test.mjs', 'test/codex-provider.test.mjs'], { stdio: 'inherit' });
if (tested.status !== 0) process.exit(tested.status ?? 1);
console.log('E2 Codex subscription provider verification passed with complete app-server package guards.');

function read(path) { return readFile(path, 'utf8'); }
