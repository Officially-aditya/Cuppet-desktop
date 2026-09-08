import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticTaskRouter } from '../src/runtime/pe3/semantic-router.mjs';

function agent(id, descriptor, revision = 1) {
  return { id:`task:${id}`, sessionID:id, taskDescriptor:descriptor, activePaths:[], touchedPaths:[], recentSymbols:[], terms:[], stalePaths:[], cacheEpoch:0, workspaceEpoch:0, createdAt:1, lastActiveAt:1, turns:1, fingerprint:{ revision, paths:[], symbols:[], terms:[] } };
}

class FakeEmbeddingProvider {
  modelID = 'fake-local';
  #vectors;
  constructor(vectors) { this.#vectors = vectors; }
  async embed(text) { const vector = this.#vectors[text]; if (vector instanceof Error) throw vector; if (!vector) throw new Error(`missing vector for ${text}`); return Float32Array.from(vector); }
}

test('semantic routing reactivates a decisive dormant task before creating novelty', async () => {
  const active = agent('a','task: auth');
  const dormant = agent('b','task: billing');
  const provider = new FakeEmbeddingProvider({
    'return billing': [0,1],
    'task: task: auth': [1,0],
    'task: task: billing': [0,1],
  });
  const router = new SemanticTaskRouter(provider);
  const decision = await router.decide('return billing', active, [dormant]);
  assert.equal(decision.action, 'reactivate');
  assert.equal(decision.agent.sessionID, 'b');
  assert.equal(decision.fallback, false);
});

test('low-confidence semantic race preserves the active task and provider failure also fails closed', async () => {
  const active = agent('a','auth');
  const dormant = agent('b','billing');
  const provider = new FakeEmbeddingProvider({
    ambiguous: [.7,.7],
    'task: auth': [.72,.69],
    'task: billing': [.69,.72],
    failure: new Error('model unavailable'),
  });
  const router = new SemanticTaskRouter(provider);
  const ambiguous = await router.decide('ambiguous', active, [dormant]);
  assert.equal(ambiguous.action, 'continue');
  assert.equal(ambiguous.fallback, true);
  const failure = await router.decide('failure', active, [dormant]);
  assert.equal(failure.action, 'continue');
  assert.equal(failure.fallback, true);
  assert.match(failure.error, /model unavailable/);
});
