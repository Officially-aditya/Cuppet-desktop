import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/use-chat-palette.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture(action = async () => ({ id: 'action', presentation: 'Done' })) {
  const slots = [], effects = [], calls = [], drafts = new Map();
  let index = 0, output, focusCount = 0;
  const props = { composerKey: 'chat:one', session: { id: 'one' }, mode: 'build', commands: [],
    focusComposer: () => focusCount++ };
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    },
    useRef(current) { return slots[index++] ??= { current }; },
    useMemo: (compute) => compute(),
    useEffect(effect, deps) {
      const slot = index++;
      if (slots[slot]?.every((value, i) => Object.is(value, deps[i]))) return;
      slots[slot] = deps;
      effects.push(effect);
    },
  };
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './palette-actions') return { executePaletteAction: (...args) => { calls.push(args); return action(...args); } };
      return {};
    },
  });
  function render() {
    const key = props.composerKey;
    props.value = drafts.get(key) ?? '';
    props.setValue = (next) => drafts.set(key, typeof next === 'function' ? next(drafts.get(key) ?? '') : next);
    index = 0;
    output = exports.useChatPalette(props);
    if (effects.length) {
      while (effects.length) effects.shift()();
      index = 0;
      output = exports.useChatPalette(props);
    }
    return output;
  }
  const children = () => output.paletteView.props.children.filter(Boolean);
  render();
  return {
    props, calls, drafts, render,
    type(value) { drafts.set(props.composerKey, value); render(); },
    value: () => drafts.get(props.composerKey) ?? '',
    palette: () => children().find((node) => node.type.name === 'CommandPalette'),
    result: () => children().find((node) => node.type.name === 'CommandResultView')?.props.result,
    focusCount: () => focusCount,
    key(key) {
      let prevented = false;
      output.handlePaletteKey({ key, nativeEvent: {}, preventDefault: () => { prevented = true; } });
      render();
      return prevented;
    },
    choose(item) { return children().find((node) => node.type.name === 'CommandPalette').props.onChoose(item); },
  };
}

const action = { id: 'action', title: 'Action', paletteOnly: true };

test('slash palette supports keyboard selection and Escape preserves the draft', () => {
  const palette = fixture();
  palette.props.commands = [{ id: 'first', slash: 'first' }, { id: 'second', slash: 'second', takesText: true }];
  palette.type('/');
  assert.equal(palette.key('ArrowDown'), true);
  assert.equal(palette.palette().props.selected, 1);
  assert.equal(palette.key('Enter'), true);
  assert.equal(palette.value(), '/second ');
  palette.type('/');
  assert.equal(palette.key('Escape'), true);
  assert.equal(palette.value(), '/');
  assert.equal(palette.palette(), undefined);
});

test('integration autocomplete selects browserControl without submitting the prompt', () => {
  const palette = fixture();
  palette.type('Inspect @bro');
  assert.equal(palette.key('Enter'), true);
  assert.equal(palette.value(), 'Inspect @browserControl ');
  assert.equal(palette.render().browserControlMentioned, true);
  assert.equal(palette.calls.length, 0);
});

test('successful palette actions clear their draft and show their result', async () => {
  const palette = fixture();
  palette.props.commands = [action];
  palette.type('/');
  await palette.choose(action);
  palette.render();
  assert.equal(palette.value(), '');
  assert.equal(palette.result().presentation, 'Done');
  assert.equal(palette.focusCount(), 1);
});

test('failed palette actions show an error instead of a successful result', async () => {
  const palette = fixture(async () => { throw new Error('Action unavailable'); });
  palette.props.commands = [action];
  palette.type('/');
  await palette.choose(action);
  palette.render();
  assert.equal(palette.result().error, true);
  assert.match(palette.result().presentation, /Action unavailable/);
});

test('pending palette actions preserve edits made in the same chat', async () => {
  let finish;
  const palette = fixture(() => new Promise((resolve) => { finish = resolve; }));
  palette.props.commands = [action];
  palette.type('/');
  const pending = palette.choose(action);
  palette.type('Keep this new prompt');
  finish({ id: 'action', presentation: 'Old result' });
  await pending;
  palette.render();
  assert.equal(palette.value(), 'Keep this new prompt');
  assert.equal(palette.result(), undefined);
  assert.equal(palette.focusCount(), 0);
});

test('pending palette actions preserve both drafts after a chat switch', async () => {
  let finish;
  const palette = fixture(() => new Promise((resolve) => { finish = resolve; }));
  palette.props.commands = [action];
  palette.type('/');
  const pending = palette.choose(action);
  palette.props.composerKey = 'chat:two';
  palette.props.session = { id: 'two' };
  palette.type('Other draft');
  finish({ id: 'action', presentation: 'Old result' });
  await pending;
  palette.render();
  assert.equal(palette.value(), 'Other draft');
  assert.equal(palette.drafts.get('chat:one'), '/');
  assert.equal(palette.result(), undefined);
  assert.equal(palette.focusCount(), 0);
});

test('keyboard selection cannot execute an action that requires a missing chat', () => {
  const palette = fixture();
  palette.props.session = null;
  palette.props.commands = [{ ...action, requiresSession: true }];
  palette.type('/');
  assert.equal(palette.key('Enter'), true);
  assert.equal(palette.calls.length, 0);
  assert.equal(palette.value(), '/');
});
