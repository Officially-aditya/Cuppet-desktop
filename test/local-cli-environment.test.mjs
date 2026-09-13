import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { localCliEnvironment } from '../src/runtime/local-cli-environment.mjs';

const bootstrapPath = fileURLToPath(new URL('../src/main/bootstrap.mjs', import.meta.url));

test('macOS local CLI environment prefers login-shell PATH over launchd PATH', () => {
  let probes = 0;
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => {
      probes += 1;
      return '/Users/cuppet-test/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin';
    },
  });

  const entries = environment.PATH.split(':');
  assert.equal(probes, 1);
  assert.equal(entries[0], '/Users/cuppet-test/.nvm/versions/node/v22/bin');
  assert.equal(entries[1], '/opt/homebrew/bin');
  assert.equal(entries.filter((entry) => entry === '/usr/bin').length, 1);
  assert.ok(entries.includes('/Users/cuppet-test/.opencode/bin'));
  assert.ok(entries.includes('/Users/cuppet-test/.bun/bin'));
});

test('explicit Cuppet CLI paths stay ahead of recovered shell paths', () => {
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin',
    CUPPET_CLI_PATH: '/custom/provider/bin:/another/provider/bin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => '/Users/cuppet-test/.local/bin:/usr/bin:/bin',
  });

  assert.deepEqual(environment.PATH.split(':').slice(0, 3), [
    '/custom/provider/bin',
    '/another/provider/bin',
    '/Users/cuppet-test/.local/bin',
  ]);
});

test('failed login-shell PATH recovery falls back without breaking CLI lookup', () => {
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    PATH: '/usr/bin:/bin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => { throw new Error('shell profile failed'); },
  });

  const entries = environment.PATH.split(':');
  assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/bin']);
  assert.ok(entries.includes('/Users/cuppet-test/.opencode/bin'));
  assert.ok(entries.includes('/opt/homebrew/bin'));
});

test('non-macOS environments never invoke login-shell recovery', () => {
  let probes = 0;
  const environment = localCliEnvironment({ HOME: '/home/cuppet', PATH: '/usr/bin:/bin' }, {
    platform: 'linux',
    home: '/home/cuppet',
    loginPathProbe: () => { probes += 1; return '/should/not/be/used'; },
  });

  assert.equal(probes, 0);
  assert.ok(!environment.PATH.includes('/should/not/be/used'));
  assert.ok(environment.PATH.includes('/home/cuppet/.local/bin'));
});

test('desktop bootstrap hydrates CLI PATH before importing the runtime', async () => {
  const source = await readFile(bootstrapPath, 'utf8');
  const hydrateIndex = source.indexOf('applyLocalCliEnvironment();');
  const runtimeImportIndex = source.indexOf("await import('./main.mjs')");
  assert.ok(hydrateIndex >= 0, 'desktop bootstrap must hydrate local CLI environment');
  assert.ok(runtimeImportIndex >= 0, 'desktop bootstrap must import the runtime');
  assert.ok(hydrateIndex < runtimeImportIndex, 'CLI PATH recovery must happen before runtime startup');
});
