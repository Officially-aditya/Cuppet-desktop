import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnsandboxed } from '../src/renderer/react/sandbox-status.ts';

const status = (platform, available) => ({ available, driverName: available ? 'driver' : 'none', platform, networkIsolation: false, credentialProtection: false });

test('Windows without a sandbox is unsandboxed: the approval prompt is the only control', () => {
  assert.equal(isUnsandboxed(status('win32', false)), true);
});

test('macOS and Linux without a sandbox refuse to run commands, so they are not unsandboxed', () => {
  assert.equal(isUnsandboxed(status('darwin', false)), false);
  assert.equal(isUnsandboxed(status('linux', false)), false);
});

test('a platform with an active sandbox is never unsandboxed', () => {
  for (const platform of ['darwin', 'linux', 'win32']) assert.equal(isUnsandboxed(status(platform, true)), false, platform);
});

test('an unknown status does not claim anything', () => {
  assert.equal(isUnsandboxed(null), false);
  assert.equal(isUnsandboxed(undefined), false);
});
