import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  askChoice, askConfirm, askForm, askText, cancelAll, cancelRequest, getCurrent, resolveRequest, subscribe,
} from '../src/renderer/react/dialog-store.ts';

afterEach(() => cancelAll());

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a text request is shown, resolves the typed text, and clears the queue', async () => {
  const pending = askText({ title: 'Steer', label: 'Instruction' });
  const request = getCurrent();
  assert.equal(request.kind, 'form');
  assert.equal(request.title, 'Steer');
  assert.deepEqual(request.fields, [{ label: 'Instruction', name: 'value' }]);
  resolveRequest(request.id, { value: 'focus on tests' });
  assert.equal(await pending, 'focus on tests');
  assert.equal(getCurrent(), null);
});

test('requests queue first-in first-out and the head is stable until it settles', async () => {
  const first = askText({ title: 'First', label: 'a' });
  const second = askConfirm({ title: 'Second' });
  const head = getCurrent();
  assert.equal(head.title, 'First');
  assert.equal(getCurrent(), head, 'the same object is returned between changes');
  resolveRequest(head.id, { value: 'x' });
  await first;
  assert.equal(getCurrent().title, 'Second');
  resolveRequest(getCurrent().id, true);
  assert.equal(await second, true);
});

test('cancelling resolves null for text, forms and choices, and false for confirmations', async () => {
  const text = askText({ title: 't', label: 'l' });
  cancelRequest(getCurrent().id);
  const form = askForm({ title: 'f', fields: [{ name: 'a', label: 'A' }] });
  cancelRequest(getCurrent().id);
  const choice = askChoice({ title: 'c', options: [{ value: 'x', label: 'X' }] });
  cancelRequest(getCurrent().id);
  const confirm = askConfirm({ title: 'k' });
  cancelRequest(getCurrent().id);
  assert.deepEqual(await Promise.all([text, form, choice, confirm]), [null, null, null, false]);
});

test('a confirmation is true only for an explicit confirm', async () => {
  const yes = askConfirm({ title: 'Remove?', destructive: true });
  assert.equal(getCurrent().destructive, true);
  resolveRequest(getCurrent().id, true);
  assert.equal(await yes, true);
  const stray = askConfirm({ title: 'Remove?' });
  resolveRequest(getCurrent().id, null);
  assert.equal(await stray, false, 'an unexpected answer is never read as consent');
  const wrongType = askConfirm({ title: 'Remove?' });
  resolveRequest(getCurrent().id, 'true');
  assert.equal(await wrongType, false, 'only the boolean true counts');
});

test('a choice resolves the chosen value', async () => {
  const pending = askChoice({ title: 'Mode', options: [{ value: 'plan', label: 'Plan' }, { value: 'build', label: 'Build' }], defaultValue: 'build' });
  assert.equal(getCurrent().kind, 'choice');
  assert.equal(getCurrent().defaultValue, 'build');
  resolveRequest(getCurrent().id, 'plan');
  assert.equal(await pending, 'plan');
});

test('a form resolves every field by name', async () => {
  const pending = askForm({ title: 'Remember', fields: [{ name: 'key', label: 'Key' }, { name: 'value', label: 'Value', multiline: true }] });
  resolveRequest(getCurrent().id, { key: 'k', value: 'v' });
  assert.deepEqual(await pending, { key: 'k', value: 'v' });
});

test('a request settles exactly once: later answers for it are ignored', async () => {
  const pending = askText({ title: 't', label: 'l' });
  const { id } = getCurrent();
  assert.equal(resolveRequest(id, { value: 'first' }), true);
  assert.equal(resolveRequest(id, { value: 'second' }), false);
  assert.equal(cancelRequest(id), false);
  assert.equal(await pending, 'first');
});

test('cancelAll settles everything that is waiting so no caller hangs', async () => {
  const all = [askText({ title: 'a', label: 'a' }), askConfirm({ title: 'b' }), askChoice({ title: 'c', options: [{ value: 'x', label: 'X' }] })];
  cancelAll();
  assert.deepEqual(await Promise.all(all), [null, false, null]);
  assert.equal(getCurrent(), null);
});

test('degenerate requests resolve immediately instead of showing an empty dialog', async () => {
  assert.equal(await askChoice({ title: 'none', options: [] }), null);
  assert.equal(await askForm({ title: 'none', fields: [] }), null);
  assert.equal(getCurrent(), null);
});

test('subscribers hear about each change and can unsubscribe', async () => {
  let calls = 0;
  const unsubscribe = subscribe(() => { calls++; });
  const pending = askConfirm({ title: 'x' });
  assert.equal(calls, 1);
  resolveRequest(getCurrent().id, true);
  await pending;
  assert.equal(calls, 2);
  unsubscribe();
  askConfirm({ title: 'y' });
  await flush();
  assert.equal(calls, 2);
});

test('answers are not mixed up between queued requests', async () => {
  const a = askText({ title: 'a', label: 'a' });
  const b = askText({ title: 'b', label: 'b' });
  const [first, second] = [getCurrent().id, getCurrent().id + 1];
  resolveRequest(second, { value: 'B' });
  resolveRequest(first, { value: 'A' });
  assert.deepEqual([await a, await b], ['A', 'B']);
});
