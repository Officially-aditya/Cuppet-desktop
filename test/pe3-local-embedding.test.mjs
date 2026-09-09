import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFeatureEmbeddingProvider, LOCAL_EMBEDDING_MODEL_ID } from '../src/runtime/pe3/local-embedding.mjs';
import { cosineSimilarity } from '../src/runtime/pe3/semantic-router.mjs';

function vectorNorm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

test('local feature embeddings are deterministic, normalized, and network-free', async () => {
  const provider = new LocalFeatureEmbeddingProvider();
  assert.equal(provider.modelID, LOCAL_EMBEDDING_MODEL_ID);

  const first = await provider.embed('Fix auth refresh token in session service');
  const repeated = await provider.embed('Fix auth refresh token in session service');
  const normalizedCase = await provider.embed('fix AUTH refresh TOKEN in SESSION service');

  assert.ok(first instanceof Float32Array);
  assert.equal(first.length, 512);
  assert.deepEqual([...repeated], [...first]);
  assert.deepEqual([...normalizedCase], [...first]);
  assert.ok(Math.abs(vectorNorm(first) - 1) < 1e-5);
});

test('local feature embeddings rank overlapping task vocabulary above unrelated work', async () => {
  const provider = new LocalFeatureEmbeddingProvider();
  const source = await provider.embed('fix auth refresh token in session service');
  const related = await provider.embed('session service auth token refresh fix');
  const unrelated = await provider.embed('animate sidebar gradient hover transition');

  assert.ok(cosineSimilarity(source, related) > cosineSimilarity(source, unrelated));
});

test('local feature embeddings bound dimensions/input and reject empty descriptions', async () => {
  const provider = new LocalFeatureEmbeddingProvider({ dimensions: 300 });
  const bounded = await provider.embed(`${'routing '.repeat(4000)}tail`);
  assert.equal(bounded.length, 512);
  await assert.rejects(() => provider.embed('   '), /empty task description/);
  await assert.rejects(() => provider.embed('***'), /no embeddable tokens/);
});
