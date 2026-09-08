import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundEnricher } from '../src/runtime/background-enricher.mjs';

function providerFactory(output) {
  return () => ({ async stream(_messages, { onDelta }) { await onDelta(output); return { text: output }; } });
}

test('background model only emits model_candidate observations and explicit user evidence is separate', async () => {
  const calls = [];
  const tst = {
    configured: true,
    async observeMemory(sessionID, value) { calls.push(['observe', sessionID, value]); return { id: 'mem1' }; },
    async recordEvidence(...args) { calls.push(['evidence', ...args]); },
  };
  const output = JSON.stringify({ candidates: [{ key: 'package manager', value: 'Use pnpm', kind: 'preference', scope: 'project', source_ids: ['s0'], relation: 'support' }] });
  const worker = new BackgroundEnricher({ providerFactory: providerFactory(output), tst, idleMs: 60_000, cooldownMs: 0 });
  await worker.ready();
  worker.setProviderConfig({ apiKey: 'test', model: 'secondary' });
  await worker.recordTurn({ sessionID: 's1', projectID: 'p1', userText: 'I prefer pnpm for this project', assistantText: 'Understood' });
  const result = await worker.flushNow('s1');
  assert.equal(result.status, 'completed');
  assert.equal(calls[0][0], 'observe');
  assert.equal(calls[0][2].provenance, 'model_candidate');
  assert.equal(calls.some((call) => call[0] === 'evidence' && call[3] === 'user_preference'), true);
  await worker.close();
});

test('background candidate containing secrets is rejected before TST observation', async () => {
  const calls = [];
  const tst = { configured: true, async observeMemory(...args) { calls.push(args); } };
  const output = JSON.stringify({ candidates: [{ key: 'api_key', value: 'sk-super-secret-value-123456789', kind: 'preference', source_ids: ['s0'] }] });
  const worker = new BackgroundEnricher({ providerFactory: providerFactory(output), tst, idleMs: 60_000, cooldownMs: 0 });
  await worker.ready(); worker.setProviderConfig({ apiKey: 'test', model: 'secondary' });
  await worker.recordTurn({ sessionID: 's1', projectID: 'p1', userText: 'remember this token', assistantText: 'no' });
  await worker.flushNow('s1');
  assert.equal(calls.length, 0);
  await worker.close();
});

test('background worker does not call a model when TST is unavailable', async () => {
  let providerCalls = 0;
  const worker = new BackgroundEnricher({ providerFactory: () => { providerCalls += 1; return { async stream() {} }; }, tst: { configured: false }, idleMs: 60_000, cooldownMs: 0 });
  await worker.ready(); worker.setProviderConfig({ apiKey: 'test', model: 'secondary' });
  await worker.recordTurn({ sessionID: 's1', projectID: 'p1', userText: 'hello', assistantText: 'hi' });
  const result = await worker.flushNow('s1');
  assert.equal(result.status, 'tst-unavailable');
  assert.equal(providerCalls, 0);
  await worker.close();
});

test('background enrichment resolves the independent secondary model and effort before provider execution', async () => {
  let received;
  const output = JSON.stringify({ candidates: [] });
  const worker = new BackgroundEnricher({
    providerFactory: (configuration) => { received = configuration; return { async stream(_messages, { onDelta }) { await onDelta(output); return { text: output }; } }; },
    tst: { configured: true }, idleMs: 60_000, cooldownMs: 0,
  });
  await worker.ready();
  worker.setProviderConfig({
    providerID: 'future-provider', baseUrl: 'https://provider.example/v1', apiKey: 'host-key',
    models: [
      { providerID: 'future-provider', modelID: 'foreground', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] } },
      { providerID: 'future-provider', modelID: 'worker', api: { id: 'worker-transport' }, capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low', body: { reasoning: { effort: 'low' } } }] },
    ],
    primary: { providerID: 'future-provider', modelID: 'foreground' },
    secondary: { providerID: 'future-provider', modelID: 'worker', variant: 'low' },
  });
  await worker.recordTurn({ sessionID: 's1', projectID: 'p1', userText: 'hello', assistantText: 'hi' });
  const result = await worker.flushNow('s1');
  assert.equal(result.status, 'completed');
  assert.equal(received.model, 'worker-transport');
  assert.equal(received.variant, 'low');
  assert.deepEqual(received.requestBody.reasoning, { effort: 'low' });
  await worker.close();
});
