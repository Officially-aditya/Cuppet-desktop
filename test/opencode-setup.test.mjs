import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localProviderOperations } from '../src/runtime/providers/local-provider-operations.mjs';
import { ProviderControlPlane } from '../src/runtime/providers/control-plane.mjs';

async function setup(t, { version = '1.18.30', installed = false, probeError = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-opencode-setup-'));
  const bin = join(root, 'Custom install directory');
  await mkdir(bin);
  const executable = join(bin, 'opencode.cmd');
  const previous = { override: process.env.CUPPET_OPENCODE_BIN, path: process.env.PATH };
  process.env.CUPPET_OPENCODE_BIN = executable;
  t.after(async () => {
    if (previous.override === undefined) delete process.env.CUPPET_OPENCODE_BIN; else process.env.CUPPET_OPENCODE_BIN = previous.override;
    process.env.PATH = previous.path;
    if (process.platform === 'win32') process.env.Path = previous.path;
    await rm(root, { recursive: true, force: true });
  });
  const calls = [];
  const create = async () => { await writeFile(executable, `CLI ${version}`); await chmod(executable, 0o755); };
  if (installed) await create();
  const operations = localProviderOperations('opencode', {
    userData: join(root, 'state'), platform: 'win32',
    runImpl: async (command, args) => {
      calls.push([...args]);
      if (args.includes('-Command')) {
        version = calls.filter(args => args.includes('-Command')).length === 1 ? '1.18.29' : '1.18.30';
        installed = true;
        await create();
        return { stdout: `__CUPPET_INSTALLED_CLI__=${executable}\n`, stderr: '' };
      }
      if (!installed) throw Object.assign(new Error('CLI missing'), { code: 'ENOENT' });
      if (args[0] === '--version') {
        if (probeError) throw Object.assign(new Error(probeError), { code: 1 });
        return { stdout: `Node.js 22.18.0 launcher notice\n${version}\n`, stderr: '' };
      }
      return { stdout: '1 credential\n', stderr: '' };
    },
  });
  return { operations, calls, root };
}

test('missing OpenCode is installed, verified, and upgraded to the ACP floor before connecting', async (t) => {
  const { operations, calls, root } = await setup(t);
  const plane = new ProviderControlPlane({ dataDir: root, operationsFactory: () => operations });
  const status = await plane.localConnect('opencode');
  assert.equal(status.control.overall, 'ready');
  assert.equal(status.control.installation.compatibility.observedVersion, '1.18.30');
  assert.equal(status.installation.ownedByCuppet, true);
  assert.equal(calls.filter(args => args.includes('-Command')).length, 2);
});

test('incompatible external OpenCode is reported without installing or changing it', async (t) => {
  const { operations, calls, root } = await setup(t, { installed: true, version: '1.18.29' });
  const plane = new ProviderControlPlane({ dataDir: root, operationsFactory: () => operations });
  await assert.rejects(() => plane.localConnect('opencode'), { code: 'PROVIDER_VERSION_UNSUPPORTED' });
  const status = await plane.localStatus('opencode');
  assert.equal(status.control.overall, 'needs_update');
  assert.equal(status.control.installation.state, 'external');
  assert.equal(calls.some(args => args.includes('-Command')), false);
});

test('an installed CLI that cannot report its version is not treated as absent', async (t) => {
  const { operations, root } = await setup(t, { installed: true, probeError: 'CLI loader failed' });
  const plane = new ProviderControlPlane({ dataDir: root, operationsFactory: () => operations });
  const status = await plane.localStatus('opencode');
  assert.equal(status.installed, true);
  assert.equal(status.control.installation.compatibility.state, 'unverified');
  assert.equal(status.control.authentication.state, 'blocked');
  assert.match(status.message, /CLI loader failed/);
});

test('missing OpenCode defers model discovery until setup instead of launching ACP', async (t) => {
  const { operations, root } = await setup(t);
  let discoveries = 0;
  const plane = new ProviderControlPlane({ dataDir: root, operationsFactory: () => operations, capabilityDiscovery: async () => { discoveries += 1; } });
  const catalog = await plane.models({ providerID: 'opencode' });
  assert.equal(catalog.available, false);
  assert.equal(discoveries, 0);
});
