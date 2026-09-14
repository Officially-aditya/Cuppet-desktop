import assert from 'node:assert/strict';
import test from 'node:test';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

test('OpenCode keeps workspace discovery read-only available', () => {
  const descriptor = localCliDescriptor('opencode');
  const environment = descriptor?.environment?.({});
  assert.ok(environment?.OPENCODE_PERMISSION, 'OpenCode must receive an explicit Cuppet permission policy');

  const permissions = JSON.parse(environment.OPENCODE_PERMISSION);
  assert.equal(permissions.read, 'allow');
  assert.equal(permissions.glob, 'allow');
  assert.equal(permissions.grep, 'allow');
  assert.equal(permissions.list, 'allow');
  assert.equal(permissions.edit, 'deny');
  assert.equal(permissions.bash, 'deny');
  assert.equal(permissions.task, 'deny');
  assert.equal(permissions.webfetch, 'deny');
  assert.equal(permissions.external_directory, 'deny');
});

test('non-workspace OpenCode capabilities remain denied', () => {
  const descriptor = localCliDescriptor('opencode');
  const permissions = JSON.parse(descriptor.environment({}).OPENCODE_PERMISSION);
  for (const key of ['question', 'todowrite', 'lsp', 'skill', 'websearch']) {
    assert.equal(permissions[key], 'deny', `${key} must remain denied`);
  }
});
