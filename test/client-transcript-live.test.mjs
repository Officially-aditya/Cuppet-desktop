import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/load-tsx.mjs';

function fixture() {
  const memos = [], effectDeps = [], effects = [];
  let memoIndex = 0, effectIndex = 0;
  const same = (a, b) => a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));
  const api = loadModule(new URL('../src/renderer/react/client-transcript.ts', import.meta.url).pathname, {
    react: {
      useMemo(compute, deps) {
        const index = memoIndex++;
        if (!memos[index] || !same(memos[index].deps, deps)) memos[index] = { deps, value: compute() };
        return memos[index].value;
      },
      useEffect(effect, deps) {
        const index = effectIndex++;
        if (!same(effectDeps[index], deps)) { effectDeps[index] = deps; effects.push(effect); }
      },
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    },
  });
  return {
    api,
    render(session) { memoIndex = effectIndex = 0; return api.useClientTranscript(session); },
    commit() { while (effects.length) effects.shift()(); },
  };
}
const row = (messageId, sequence, activity) => ({ sessionId: 's1', messageId, sequence, source: 'provider', createdAt: 1, activity });
const reasoning = (text) => ({ type: 'activity.reasoning.delta', text });

test('live transcript updates preserve historical trace identities and use the canonical store', () => {
  const { api, render, commit } = fixture();
  const session = { id: 's1', messages: [], activities: [row('old', 1, reasoning('Earlier work')), row('live', 1, reasoning('Start'))] };
  assert.equal(render(session).old.items[0].text, 'Earlier work', 'durable history is available on the first render');
  commit();
  const loaded = render(session);
  const history = loaded.old;
  for (let index = 2; index < 40; index++) {
    api.reduceClientTranscriptEvent({ type: 'runtime.activity', sessionId: 's1', messageId: 'live', source: 'provider', sequence: index, activity: reasoning(' more ' + index) });
    const next = render(session);
    assert.equal(next, api.clientTranscriptSnapshot('s1'), 'the hook must not rebuild a second projection for each token');
    assert.equal(next.old, history);
    assert.equal(next.old.items, history.items);
  }
  assert.match(render(session).live.items[0].text, /^Start more/);
});

test('a refreshed durable snapshot still merges new history without rolling back live work', () => {
  const { api, render, commit } = fixture();
  const original = [row('old', 1, reasoning('Earlier work')), row('live', 1, reasoning('Start'))];
  render({ id: 's1', messages: [], activities: original });
  commit();
  api.reduceClientTranscriptEvent({ type: 'runtime.activity', sessionId: 's1', messageId: 'live', source: 'provider', sequence: 2, activity: reasoning(' new guidance') });
  const refreshed = { id: 's1', messages: [], activities: [...original, row('another-old', 1, reasoning('Loaded from the server'))] };
  render(refreshed);
  commit();
  const result = render(refreshed);
  assert.equal(result['another-old'].items[0].text, 'Loaded from the server');
  assert.equal(result.live.items[0].text, 'Start new guidance');
  assert.equal(result, api.clientTranscriptSnapshot('s1'));
});
