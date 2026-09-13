import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/react/provider-status-presentation.ts', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');

function project(status, providerLabel = 'OpenCode', busy = false) {
  const transformed = source
    .replace(/export type ProviderStatusPresentation = \{[\s\S]*?\};\n\n/, '')
    .replace('export function providerStatusPresentation', 'function providerStatusPresentation')
    .replace(/: unknown/g, '')
    .replace(/: string/g, '')
    .replace(/: ProviderStatusPresentation/g, '')
    .replace(/: Record<string, any>/g, '')
    .replace(/ as Record<string, any>/g, '');
  return Function(`${transformed}; return providerStatusPresentation(arguments[0], arguments[1], arguments[2]);`)(status, providerLabel, busy);
}

test('unknown provider observation remains checking rather than missing', () => {
  const value = project({ providerID: 'opencode', available: false, message: 'Checking local CLI…' });
  assert.equal(value.credentialReady, false);
  assert.equal(value.badge, 'Checking…');
  assert.equal(value.canConnect, false);
});

test('authenticated stopped provider is connected and idle, not broken', () => {
  const value = project({
    installed: true,
    connected: true,
    control: {
      overall: 'ready',
      authentication: { state: 'authenticated' },
      runtime: { state: 'stopped' },
      capabilities: { state: 'unknown' },
    },
  });
  assert.equal(value.credentialReady, true);
  assert.equal(value.badge, 'Connected');
  assert.match(value.detail, /idle and will start on demand/i);
  assert.equal(value.canConnect, false);
});

test('incompatible provider version is neither missing nor unauthenticated', () => {
  const value = project({
    installed: true,
    connected: false,
    message: 'OpenCode 1.18.29 is installed, but Cuppet requires OpenCode 1.18.30 or newer. Upgrade OpenCode outside Cuppet, then retry.',
    control: {
      overall: 'needs_update',
      installation: {
        canUpdate: false,
        compatibility: { state: 'too_old', supported: false, minimumVersion: '1.18.30', observedVersion: '1.18.29' },
      },
      authentication: { state: 'blocked' },
      runtime: { state: 'stopped' },
      capabilities: { state: 'blocked' },
    },
  });
  assert.equal(value.credentialReady, false);
  assert.equal(value.badge, 'Update required');
  assert.equal(value.tone, 'warning');
  assert.match(value.detail, /1\.18\.30 or newer/i);
  assert.equal(value.canConnect, false);
});

test('Cuppet-managed incompatible provider can use Connect as the explicit repair mutation', () => {
  const value = project({
    installed: true,
    connected: false,
    control: {
      overall: 'needs_update',
      installation: {
        canUpdate: true,
        compatibility: { state: 'too_old', supported: false, minimumVersion: '1.18.30', observedVersion: '1.18.29' },
      },
      authentication: { state: 'blocked' },
      runtime: { state: 'stopped' },
      capabilities: { state: 'blocked' },
    },
  });
  assert.equal(value.badge, 'Update required');
  assert.equal(value.canConnect, true);
});

test('transport crash remains authenticated and becomes needs retry', () => {
  const value = project({
    installed: true,
    connected: true,
    control: {
      overall: 'needs_retry',
      authentication: { state: 'authenticated' },
      runtime: { state: 'crashed', lastFailure: { category: 'process_exited' } },
      capabilities: { state: 'ready' },
    },
  });
  assert.equal(value.credentialReady, true);
  assert.equal(value.badge, 'Needs retry');
  assert.equal(value.tone, 'warning');
  assert.match(value.detail, /authentication is still connected/i);
  assert.match(value.detail, /process exited/i);
  assert.equal(value.canConnect, false);
});

test('auth failure remains distinct from runtime failure', () => {
  const value = project({
    installed: true,
    connected: false,
    control: {
      overall: 'needs_auth',
      authentication: { state: 'required' },
      runtime: { state: 'stopped' },
      capabilities: { state: 'blocked' },
    },
  });
  assert.equal(value.credentialReady, false);
  assert.equal(value.badge, 'Not connected');
  assert.equal(value.canConnect, true);
});

test('capability discovery failure does not pretend auth or runtime failed', () => {
  const value = project({
    installed: true,
    connected: true,
    control: {
      overall: 'ready',
      authentication: { state: 'authenticated' },
      runtime: { state: 'ready' },
      capabilities: { state: 'failed', error: 'model discovery failed' },
    },
  });
  assert.equal(value.credentialReady, true);
  assert.equal(value.badge, 'Connected');
  assert.equal(value.tone, 'warning');
  assert.equal(value.detail, 'model discovery failed');
});

test('settings renders the runtime-owned provider projection instead of flattening connected state', () => {
  assert.match(settingsSource, /providerStatusPresentation\(cliStatus,/);
  assert.match(settingsSource, /cliPresentation\.credentialReady/);
  assert.match(settingsSource, /cliPresentation\.badge/);
  assert.match(settingsSource, /Retry next request/);
  assert.doesNotMatch(settingsSource, /const cliConnected = Boolean\(cliStatus\?\.connected/);
  assert.doesNotMatch(settingsSource, /cliConnected \? 'Connected'/);
});
