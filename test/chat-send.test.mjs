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

async function fixture({ activeSession = null, running = false, executeError = null, sessionLoads = new Map(), modeLoads = new Map() } = {}) {
  const created = deferred(), sent = deferred(), loaded = deferred(), deleted = deferred();
  const states = [], effects = [], saved = new Map(), sends = [], deletions = [], executions = [], pendingAdded = [], pendingRemoved = [];
  let stateIndex = 0, sessions = activeSession ? [activeSession] : [];
  const refs = [];
  let refIndex = 0;
  if (activeSession) saved.set('cuppet.desktop.last-session', activeSession.id);
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
    useLayoutEffect: (effect) => effects.push(effect),
    useRef: (initial) => refs[refIndex++] ??= { current: initial },
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
        refreshClientSession: async (id) => {
          const session = await (sessionLoads.get(id)?.promise ?? loaded.promise);
          upsertClientSession(session);
          return session;
        },
        upsertClientSession,
        addPendingUserMessage(input) { pendingAdded.push(input); return `pending_${pendingAdded.length}`; },
        removePendingUserMessage(id) { pendingRemoved.push(id); },
      };
      if (name === './client-run-state') return {
        useClientRunState: () => new Set(running && activeSession ? [activeSession.id] : []),
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
      projects: { list: async () => [], open: async () => {} },
      sessions: {
        create: () => created.promise,
        delete: (id) => { deletions.push(id); return deleted.promise; },
        send: (...args) => { sends.push(args); return sent.promise; },
      },
      cognitive: { status: async () => ({}), modeGet: (id) => modeLoads.get(id)?.promise ?? Promise.resolve({ mode: 'build' }) },
      commands: { list: async () => [], execute: async (...args) => { executions.push(args); if (executeError) throw executeError; return { result: { accepted: true } }; } },
      permissions: { list: async () => [] },
      questions: { list: async () => [] },
    } },
  });
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    effects.length = 0;
    return exports.App();
  };
  const pane = () => render().props.children.find((node) => node?.type === ChatPane).props;
  const sidebar = () => render().props.children.find(node => node?.props?.onDeleteSession).props;
  const toast = () => render().props.children.find(node => node?.props?.onClear).props.message;
  const settle = () => new Promise(setImmediate);
  if (activeSession) loaded.resolve(activeSession);
  render();
  effects.find((effect) => effect.toString().includes('Runtime unavailable'))();
  await settle();
  return { pane, sidebar, toast, created, sent, loaded, deleted, deletions, sends, executions, pendingAdded, pendingRemoved, saved, settle };
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
    assert.equal(chat.pane().draft, null, 'the submitted conversation is selected immediately');
    assert.equal(chat.pane().loading, true, 'a skeleton covers the initial history fetch');

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

for (const attachments of [[], [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }]]) {
  test(`steering delivers the full prompt and ${attachments.length} attachments to the running chat`, async () => {
    const chat = await fixture({ activeSession: { id: 'busy', messages: [] }, running: true });
    const text = 'additional guidance '.repeat(500);
    assert.equal((await chat.pane().onSend(text, 'steer', attachments)).clear, true);
    assert.equal(chat.sends.length, 0, 'steering must not enqueue another turn');
    assert.equal(chat.executions[0][0], 'busy');
    assert.equal(chat.executions[0][1].id, 'cuppet.steer.interrupt');
    assert.equal(chat.executions[0][1].input.text, text.trim());
    assert.deepEqual(chat.executions[0][1].input.attachments ?? [], attachments);
    assert.equal(chat.pendingAdded[0].content, text.trim());
    assert.equal(chat.pendingAdded[0].attachments, attachments);
    assert.equal(chat.pendingRemoved.length, 0, 'the prompt remains visible until confirmation');
  });
}

test('a failed steer removes its pending bubble and retains the composer draft', async () => {
  const chat = await fixture({ activeSession: { id: 'busy', messages: [] }, running: true, executeError: new Error('steer failed') });
  assert.equal((await chat.pane().onSend('try again', 'steer', [])).clear, false);
  assert.deepEqual(chat.pendingRemoved, ['pending_1']);
});

test('queue mode still queues attachments without a pending history bubble', async () => {
  const chat = await fixture({ activeSession: { id: 'busy', messages: [] }, running: true });
  const attachments = [{ name: 'notes.txt' }];
  chat.sent.resolve({ queued: true, queueId: 'q1' });
  assert.equal((await chat.pane().onSend('later', 'queue', attachments)).clear, true);
  assert.equal(chat.executions.length, 0);
  assert.equal(chat.sends[0][2], attachments);
  assert.equal(chat.pendingAdded.length, 0);
  assert.equal(chat.pane().queuedTurns[0].params.attachments, attachments);
});

test('deleting the open chat immediately opens a fresh draft in the same project', async () => {
  const session = { id: 'delete-me', projectId: 'project-a', title: 'Old chat', messages: [] };
  const chat = await fixture({ activeSession: session });
  assert.equal(chat.sidebar().onDeleteSession(session), undefined, 'confirmation must not await backend deletion');
  assert.deepEqual(chat.deletions, ['delete-me']);
  assert.equal(chat.pane().session, null);
  assert.equal(chat.pane().draft.projectId, 'project-a');
  await chat.settle();
  assert.equal(chat.pane().session, null, 'the new-chat view is available while deletion is unresolved');
  chat.sidebar().onNewProjectChat('project-b');
  chat.deleted.resolve({ deleted: true });
  await chat.settle();
  assert.equal(chat.pane().draft.projectId, 'project-b', 'late deletion must not navigate away from newer work');
  assert.match(chat.toast(), /Deleted.*Old chat/);
});

test('a failed background deletion reports the error without discarding the fresh draft', async () => {
  const session = { id: 'delete-fails', projectId: 'project-a', messages: [] };
  const chat = await fixture({ activeSession: session });
  chat.sidebar().onDeleteSession(session);
  chat.deleted.reject(new Error('Cannot delete this chat'));
  await chat.settle();
  assert.equal(chat.pane().session, null);
  assert.equal(chat.pane().draft.projectId, 'project-a');
  assert.match(chat.toast(), /Cannot delete this chat/);
});

test('deleting a different chat does not change the current conversation', async () => {
  const session = { id: 'keep-open', projectId: 'project-a', messages: [] };
  const chat = await fixture({ activeSession: session });
  chat.sidebar().onDeleteSession({ id: 'other-chat', projectId: 'project-b' });
  assert.equal(chat.pane().session.id, 'keep-open');
  chat.deleted.resolve({ deleted: true });
  await chat.settle();
  assert.equal(chat.pane().session.id, 'keep-open');
});

test('rapid A to B to C switches stay on C despite late session and mode responses', async () => {
  const sessionLoads = new Map(['A', 'B', 'C'].map(id => [id, deferred()]));
  const modeLoads = new Map(['A', 'B', 'C'].map(id => [id, deferred()]));
  const chat = await fixture({ sessionLoads, modeLoads });
  const requests = ['A', 'B', 'C'].map(id => chat.sidebar().onSession(id));
  assert.equal(chat.sidebar().activeSessionId, 'C');
  assert.equal(chat.pane().loading, true);
  sessionLoads.get('C').resolve({ id: 'C', messages: [] });
  await requests[2];
  assert.equal(chat.pane().session.id, 'C');
  assert.equal(chat.pane().loading, false, 'modeGet does not delay loading the conversation');
  modeLoads.get('C').resolve({ mode: 'plan' });
  for (const id of ['B', 'A']) {
    sessionLoads.get(id).resolve({ id, messages: [] });
    modeLoads.get(id).resolve({ mode: 'build' });
  }
  await Promise.all(requests);
  await chat.settle();
  assert.equal(chat.sidebar().activeSessionId, 'C');
  assert.equal(chat.pane().mode, 'plan');
  assert.equal(chat.saved.get('cuppet.desktop.last-session'), 'C');
});

test('a failed switch restores the loaded chat and reports the error', async () => {
  const failure = deferred();
  const chat = await fixture({ activeSession: { id: 'A', messages: [] }, sessionLoads: new Map([['B', failure]]) });
  const switching = chat.sidebar().onSession('B');
  assert.equal(chat.sidebar().activeSessionId, 'B');
  failure.reject(new Error('history unavailable'));
  await switching;
  assert.equal(chat.sidebar().activeSessionId, 'A');
  assert.equal(chat.pane().session.id, 'A');
  assert.equal(chat.pane().loading, false);
  assert.match(chat.toast(), /history unavailable/);
  assert.equal(chat.saved.get('cuppet.desktop.last-session'), 'A');
});

test('starting a draft cancels an outstanding switch without reopening its chat', async () => {
  const pending = deferred();
  const chat = await fixture({ sessionLoads: new Map([['B', pending]]) });
  const switching = chat.sidebar().onSession('B');
  chat.sidebar().onNewProjectChat('project');
  pending.resolve({ id: 'B', messages: [] });
  await switching;
  assert.equal(chat.sidebar().activeSessionId, null);
  assert.equal(chat.pane().draft.projectId, 'project');
  assert.equal(chat.pane().loading, false);
});
