import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture() {
  const created = deferred(), sent = deferred(), loaded = deferred();
  const states = [], effects = [], saved = new Map(), sends = [];
  let stateIndex = 0, sessions = [];
  const ChatPane = () => null;
  const react = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useMemo: (compute) => compute(),
    useCallback: (callback) => callback,
    useEffect: (effect) => effects.push(effect),
  };
  const upsertClientSession = (session) => {
    sessions = [...sessions.filter((item) => item.id !== session.id), session];
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './ChatPane') return { ChatPane };
      if (name === './client-session-state') return {
        useClientSessions: () => sessions,
        useClientUnreadSessions: () => new Set(),
        refreshClientSessions: async () => sessions,
        refreshClientSession: async () => {
          const session = await loaded.promise;
          upsertClientSession(session);
          return session;
        },
        upsertClientSession,
      };
      if (name === './client-run-state') return {
        useClientRunState: () => new Set(),
        hydrateClientRunState() {}, hydrateClientRunSession() {}, markClientRunStarted() {},
      };
      if (name === './client-provider-state') return {
        useClientProviderSettings: () => ({ configured: true, credentialConfigured: true, primary: { modelID: 'test' } }),
        refreshClientProviderSettings: async () => ({}),
      };
      return {};
    },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    window: { cuppet: {
      health: async () => ({ ok: true }),
      projects: { list: async () => [] },
      sessions: {
        create: () => created.promise,
        send: (...args) => { sends.push(args); return sent.promise; },
      },
      cognitive: { status: async () => ({}), modeGet: async () => ({ mode: 'build' }) },
      commands: { list: async () => [] },
      permissions: { list: async () => [] },
      questions: { list: async () => [] },
    } },
  });
  const render = () => {
    stateIndex = 0;
    effects.length = 0;
    return exports.App();
  };
  const pane = () => render().props.children.find((node) => node?.type === ChatPane).props;
  const settle = () => new Promise(setImmediate);
  render();
  effects.find((effect) => effect.toString().includes('Runtime unavailable'))();
  await settle();
  return { pane, created, sent, loaded, sends, saved, settle };
}

for (const target of ['created-chat', 'routed-chat']) {
  test(`first prompt stays in its draft until the saved conversation is ready (${target})`, async () => {
    const chat = await fixture();
    const originalDraft = chat.pane().draft;
    const attachments = [{ name: 'notes.txt', size: 12 }];
    let finished = false;
    const sending = chat.pane().onSend('first prompt', 'queue', attachments).then((result) => {
      finished = true;
      return result;
    });
    assert.equal(chat.pane().draft, originalDraft);
    assert.equal(chat.pane().session, null);

    chat.created.resolve({ id: 'created-chat', messages: [] });
    await chat.settle();
    assert.equal(chat.sends.length, 1);
    assert.equal(chat.sends[0][0], 'created-chat');
    assert.equal(chat.sends[0][1], 'first prompt');
    assert.equal(chat.sends[0][2], attachments);
    assert.equal(chat.pane().draft, originalDraft, 'session creation must not hide the submitted draft');
    assert.equal(chat.pane().session, null);
    assert.equal(chat.saved.has('cuppet.desktop.last-session'), false);

    chat.sent.resolve({ accepted: true, sessionId: target });
    await chat.settle();
    assert.equal(finished, false, 'do not clear the composer before the saved prompt is loaded');
    assert.equal(chat.pane().draft, originalDraft);
    assert.equal(chat.pane().session, null);

    chat.loaded.resolve({
      id: target,
      messages: [{ id: 'user-1', sessionId: target, role: 'user', content: 'first prompt', attachments }],
    });
    assert.equal((await sending).clear, true);
    assert.equal(chat.pane().draft, null);
    assert.equal(chat.pane().session.id, target);
    assert.equal(chat.pane().session.messages[0].content, 'first prompt');
    assert.equal(chat.pane().session.messages[0].attachments, attachments);
    assert.equal(chat.saved.get('cuppet.desktop.last-session'), target);
  });
}

test('a failed first send keeps the original draft visible for retry', async () => {
  const chat = await fixture();
  const originalDraft = chat.pane().draft;
  const sending = chat.pane().onSend('keep this prompt', 'queue', []);
  chat.created.resolve({ id: 'created-chat', messages: [] });
  await chat.settle();
  chat.sent.reject(new Error('send failed'));
  assert.equal((await sending).clear, false);
  assert.equal(chat.pane().session, null);
  assert.equal(chat.pane().draft, originalDraft);
  assert.equal(chat.saved.has('cuppet.desktop.last-session'), false);
});
