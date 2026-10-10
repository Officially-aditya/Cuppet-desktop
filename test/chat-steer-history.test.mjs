import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source + '\nexport { MessageView };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function fixture() {
  const states = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return {
        useState(initial) {
          const slot = stateIndex++;
          if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
          return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next; }];
        },
        useRef(initial) {
          const slot = refIndex++;
          return refs[slot] ??= { current: initial };
        },
        useMemo: (compute) => compute(),
        useEffect: (effect) => effects.push(effect),
      };
      if (name === 'react/jsx-runtime') return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      };
      return { renderMarkdown: (value) => value, formatWorkedDuration: () => '1s' };
    },
  });
  return {
    render(status, live = false) {
      stateIndex = refIndex = 0;
      effects.length = 0;
      const tree = exports.MessageView({
        message: { id: 'previous-work', role: 'assistant', content: '', status, createdAt: 1, updatedAt: 1001 },
        trace: [{ id: 'reasoning', type: 'reasoning', text: 'Previous work', sequence: 1 }],
        live,
      });
      for (const effect of effects) effect();
      return { tree, traceOpen: states[0] };
    },
  };
}

test('steering keeps the previous response activity expanded after stopping', () => {
  const view = fixture();
  assert.equal(view.render('streaming', true).traceOpen, true);
  assert.equal(view.render('stopped').traceOpen, true);
  assert.equal(view.render('stopped').traceOpen, true);
});

test('stopped response activity remains visible when mounted from history', () => {
  assert.equal(fixture().render('stopped').traceOpen, true);
});

test('successful completion still collapses the activity trace', () => {
  const view = fixture();
  view.render('streaming', true);
  assert.equal(view.render('complete').traceOpen, false);
});
