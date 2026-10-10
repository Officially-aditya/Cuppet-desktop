import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { antigravityBackendDefinition } from '../src/runtime/providers/backends/antigravity.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityReleaseAsset, resolveAntigravityAcpInstallation } from '../src/runtime/providers/backends/antigravity-install.mjs';

test('Antigravity detects an app ACP runtime on Windows before downloading anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-agy-app-'));
  const bin = join(root, 'resources', 'runtime');
  const command = join(bin, 'agy_acp_server.exe');
  const harnessPath = join(bin, 'localharness_external.exe');
  const options = {
    platform: 'win32', arch: 'x64', appDirectories: [root], installRoot: join(root, 'managed'),
    fetchImpl: async () => { throw new Error('must reuse the app runtime'); },
  };
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(command, 'app server');
    assert.equal(await resolveAntigravityAcpInstallation({}, { ...options, allowInstall: false }), null);
    await writeFile(harnessPath, 'app harness');
    const result = await resolveAntigravityAcpInstallation({}, options);
    assert.equal(result.command, command);
    assert.equal(result.harnessPath, harnessPath);
    assert.equal(result.source, 'native');
    assert.equal(await readFile(command, 'utf8'), 'app server');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const installation = Object.freeze({ command: process.execPath, harnessPath: fixture, args: [fixture], version: 'test', source: 'override' });

test('Antigravity model discovery comes from the provider ACP session catalog', async () => {
  const backend = antigravityBackendDefinition();
  const catalog = await backend.operations.discoverCapabilities({
    configuration: { providerID: 'antigravity' },
    options: { resolveInstallation: async () => installation },
  });
  assert.equal(catalog.source, 'acp');
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ['provider/model-a', 'provider/model-b']);
  assert.equal(catalog.currentModel, 'provider/model-a');
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.ok(catalog.settings.some((setting) => setting.id === 'model'));
});

test('managed Antigravity macOS release is pinned to Google ACP 1.1.1 with verified metadata', () => {
  const release = antigravityReleaseAsset('darwin', 'arm64');
  assert.ok(release);
  assert.match(release.url, /^https:\/\/dl\.google\.com\/agy-extensions\/releases\/macos\//);
  assert.equal(release.sha256, 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189');
  assert.equal(release.archiveBytes, 316_014_828);
  assert.equal(release.executable.name, 'agy_acp_server.par');
  assert.equal(release.harness.name, 'localharness_external');
});
