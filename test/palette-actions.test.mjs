import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModule } from './helpers/load-tsx.mjs';

// palette-actions imports its sibling extensionlessly (as the bundler wants), so it is loaded through the TSX
// loader, sharing the one dialog store instance that this test drives.
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const store = loadModule(path('../src/renderer/react/dialog-store.ts'));
const { cancelAll, cancelRequest, getCurrent, resolveRequest } = store;
const { executePaletteAction } = loadModule(path('../src/renderer/react/palette-actions.ts'), { './dialog-store': store });

let executed;
beforeEach(() => {
  executed = [];
  globalThis.window = { cuppet: { commands: { execute: async (sessionId, call) => { executed.push({ sessionId, ...call }); return { id: call.id, presentation: 'done' }; } } } };
});
afterEach(() => cancelAll());

const item = (id, extra = {}) => ({ id, label: id, requiresSession: true, paletteOnly: true, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Runs an action, lets the test answer the dialog it opens, and returns what the action resolved.
async function run(command, answer, { sessionId = 's1', mode = 'build' } = {}) {
  const pending = executePaletteAction(command, sessionId, mode);
  await tick();
  const request = getCurrent();
  if (answer === 'cancel') cancelRequest(request.id); else if (answer !== undefined) resolveRequest(request.id, answer);
  return { result: await pending, request };
}

test('remember asks for a key and a value together, then stores them in the project scope', async () => {
  const { request } = await run(item('cuppet.memory.remember'), { key: 'test-command', value: 'npm test' });
  assert.equal(request.kind, 'form');
  assert.deepEqual(request.fields.map((field) => field.name), ['key', 'value']);
  assert.deepEqual(executed, [{ sessionId: 's1', id: 'cuppet.memory.remember', input: { key: 'test-command', value: 'npm test', scope: 'project' } }]);
});

test('forget asks for the key in a destructive dialog', async () => {
  const { request } = await run(item('cuppet.memory.forget'), { value: 'old-key' });
  assert.equal(request.destructive, true);
  assert.deepEqual(executed[0].input, { key: 'old-key' });
});

test('clear offers the three scopes as a choice, so a typo can no longer mean "no scope"', async () => {
  const { request } = await run(item('cuppet.memory.clear'), 'global');
  assert.equal(request.kind, 'choice');
  assert.deepEqual(request.options.map((option) => option.value), ['session', 'project', 'global']);
  assert.equal(request.defaultValue, 'session');
  assert.equal(request.destructive, true);
  assert.deepEqual(executed[0].input, { scope: 'global' }, 'choosing and confirming is the confirmation; there is no second prompt');
});

test('steer sends the instruction as typed text', async () => {
  const { request } = await run(item('cuppet.steer.interrupt'), { value: 'focus on the tests' });
  assert.equal(request.fields[0].multiline, true);
  assert.deepEqual(executed[0].input, { text: 'focus on the tests' });
});

test('mode is a choice that starts on the current mode', async () => {
  const { request } = await run(item('cuppet.plan.agent'), 'plan', { mode: 'build' });
  assert.equal(request.defaultValue, 'build');
  assert.deepEqual(request.options.map((option) => option.value), ['plan', 'build']);
  assert.deepEqual(executed[0].input, { mode: 'plan' });
  const again = await run(item('cuppet.plan.agent'), 'build', { mode: 'plan' });
  assert.equal(again.request.defaultValue, 'plan');
});

test('cancelling any dialog runs nothing and resolves null', async () => {
  for (const id of ['cuppet.memory.remember', 'cuppet.memory.forget', 'cuppet.memory.clear', 'cuppet.steer.interrupt', 'cuppet.plan.agent']) {
    const { result } = await run(item(id), 'cancel');
    assert.equal(result, null, id);
  }
  assert.deepEqual(executed, []);
});

test('an action that needs no input runs straight away without a dialog', async () => {
  const pending = executePaletteAction(item('cuppet.background.pause'), 's1', 'build');
  await tick();
  assert.equal(getCurrent(), null);
  assert.deepEqual(await pending, { id: 'cuppet.background.pause', presentation: 'done' });
  assert.deepEqual(executed[0].input, {});
});

test('an action that needs a chat says so, before asking for anything', async () => {
  await assert.rejects(executePaletteAction(item('cuppet.steer.interrupt'), null, 'build'), /Start or open a chat/);
  assert.equal(getCurrent(), null);
  assert.deepEqual(executed, []);
});

test('an action that works without a chat is allowed to', async () => {
  const pending = executePaletteAction(item('cuppet.memory.forget', { requiresSession: false }), null, 'build');
  await tick();
  resolveRequest(getCurrent().id, { value: 'k' });
  await pending;
  assert.equal(executed[0].sessionId, null);
});

test('a runtime failure is thrown to the caller, not swallowed', async () => {
  globalThis.window.cuppet.commands.execute = async () => { throw new Error('memory store locked'); };
  const pending = executePaletteAction(item('cuppet.memory.clear'), 's1', 'build');
  await tick();
  resolveRequest(getCurrent().id, 'session');
  await assert.rejects(pending, /memory store locked/);
});
