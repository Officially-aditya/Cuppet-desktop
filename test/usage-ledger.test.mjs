import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageLedger, normalizeTokenUsage } from '../src/runtime/usage-ledger.mjs';

test('normalizes exact usage fields across provider payload shapes', () => {
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 12 },
  }), { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 40, reasoningTokens: 12 });

  assert.deepEqual(normalizeTokenUsage({
    promptTokenCount: 70,
    candidatesTokenCount: 20,
    totalTokenCount: 90,
    cachedContentTokenCount: 10,
    thoughtsTokenCount: 5,
  }), { inputTokens: 70, outputTokens: 20, totalTokens: 90, cachedInputTokens: 10, reasoningTokens: 5 });

  assert.equal(normalizeTokenUsage(null), null);
  assert.equal(normalizeTokenUsage({ unrelated: 1 }), null);
});

test('persists exact totals and keeps missing telemetry out of token counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-usage-'));
  const path = join(directory, 'token-usage.json');
  try {
    const ledger = new TokenUsageLedger(path);
    await ledger.record({ providerID: 'codex', modelID: 'gpt-test', usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 }, now: 1000 });
    await ledger.record({ providerID: 'codex', modelID: 'gpt-test', usage: null, now: 2000 });
    await ledger.record({ providerID: 'zai', modelID: 'glm-test', usage: { prompt_tokens: 40, completion_tokens: 10 }, now: 3000 });

    const summary = await ledger.summary();
    assert.equal(summary.requests, 3);
    assert.equal(summary.trackedRequests, 2);
    assert.equal(summary.unreportedRequests, 1);
    assert.equal(summary.inputTokens, 140);
    assert.equal(summary.outputTokens, 35);
    assert.equal(summary.totalTokens, 175);
    assert.equal(summary.byModel.length, 2);
    assert.equal(summary.byModel.find((item) => item.modelID === 'gpt-test')?.unreportedRequests, 1);

    const reopened = new TokenUsageLedger(path);
    const persisted = await reopened.summary();
    assert.equal(persisted.totalTokens, 175);
    assert.equal(persisted.requests, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
