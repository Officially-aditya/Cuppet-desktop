import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModule } from './helpers/load-tsx.mjs';

const presets = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'kiro', label: 'Kiro' },
];
const settings = (providerID = 'codex') => ({
  providerID, primary: { providerID, modelID: providerID + '-saved-model' },
  savedProviderIDs: ['codex', 'claude-code'], presets,
});
const SelectControl = () => null;
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

function fixture(t, initial = settings()) {
  let current = initial, index = 0, notifications = 0;
  const slots = [], calls = [], busyChanges = [];
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  let save = async ({ providerID }) => settings(providerID);
  globalThis.window = { cuppet: { settings: { save: async (input) => {
    calls.push(input);
    return save(input);
  } } } };
  const { PlatformPicker } = loadModule(fileURLToPath(new URL('../src/renderer/react/PlatformPicker.tsx', import.meta.url)), {
    react: {
      useState(initial) {
        const i = index++;
        if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
        return [slots[i], (next) => { slots[i] = next; }];
      },
      useRef(initial) { return slots[index++] ??= { current: initial }; },
    },
    './SelectControl': { SelectControl },
    './client-provider-state': {
      useClientProviderSettings: () => current,
      hydrateClientProviderSettings: (next) => { current = next; },
    },
    './provider-settings-events': { notifyProviderSettingsChanged: () => { notifications++; } },
  });
  const render = (props = {}) => {
    index = 0;
    return PlatformPicker({ onBusyChange: (busy) => busyChanges.push(busy), ...props });
  };
  return {
    render,
    select(props) { return nodes(render(props)).find((node) => node.type === SelectControl).props; },
    current: () => current,
    setSettings: (next) => { current = next; },
    notifications: () => notifications,
    save: (handler) => { save = handler; },
    calls, busyChanges,
  };
}

test('platform choices include only saved platforms, deduplicate IDs, and preserve custom platforms', (t) => {
  const picker = fixture(t, { ...settings(), savedProviderIDs: ['codex', 'custom-platform', 'codex', ''] });
  const select = picker.select();
  assert.equal(select.value, 'codex');
  assert.equal(select.ariaLabel, 'Select platform');
  assert.deepEqual(select.options.map(({ value, label }) => ({ value, label })), [
    { value: 'codex', label: 'Codex' }, { value: 'custom-platform', label: 'custom-platform' },
  ]);
});

test('empty or loading settings keep the platform picker disabled without listing unused presets', (t) => {
  const picker = fixture(t);
  for (const initial of [null, { ...settings(), savedProviderIDs: [] }, { providerID: 'default', presets }]) {
    picker.setSettings(initial);
    assert.equal(picker.select().disabled, true);
    assert.deepEqual(picker.select().options, [{ value: '', label: 'Platform', disabled: true }]);
  }
});

test('switch saves only the platform ID, waits for authority, synchronizes settings, and blocks overlapping switches', async (t) => {
  const picker = fixture(t);
  let finish;
  picker.save(() => new Promise((resolve) => { finish = resolve; }));
  const choose = picker.select().onChange;
  const pending = choose('claude-code');
  assert.equal(picker.select().disabled, true);
  assert.ok(picker.select().options.every((option) => option.disabled));
  assert.equal(picker.current().providerID, 'codex');
  await choose('codex');
  await choose('claude-code');
  assert.deepEqual(picker.calls, [{ providerID: 'claude-code' }]);
  const restored = { ...settings('claude-code'), primaryEffort: 'max' };
  finish(restored);
  await pending;
  assert.equal(picker.current(), restored);
  assert.equal(picker.select().value, 'claude-code');
  assert.equal(picker.select().disabled, false);
  assert.equal(picker.notifications(), 1);
  assert.deepEqual(picker.busyChanges, [true, false]);
});

test('current, unavailable, and disabled platform selections do not save', async (t) => {
  const picker = fixture(t);
  await picker.select().onChange('codex');
  await picker.select().onChange('kiro');
  await picker.select({ disabled: true }).onChange('claude-code');
  assert.deepEqual(picker.calls, []);
  assert.deepEqual(picker.busyChanges, []);
});

test('failed switches retain the selected platform, report the error, and permit retry', async (t) => {
  const picker = fixture(t);
  picker.save(async () => { throw new Error('Platform could not be saved'); });
  await picker.select().onChange('claude-code');
  assert.equal(picker.select().value, 'codex');
  assert.equal(picker.select().disabled, false);
  assert.equal(nodes(picker.render()).find((node) => node.props.role === 'alert').props.children, 'Platform could not be saved');
  assert.equal(picker.notifications(), 0);
  assert.deepEqual(picker.busyChanges, [true, false]);
  picker.save(async ({ providerID }) => settings(providerID));
  await picker.select().onChange('claude-code');
  assert.equal(picker.select().value, 'claude-code');
  assert.ok(!nodes(picker.render()).some((node) => node.props.role === 'alert'));
});
