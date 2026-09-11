import assert from 'node:assert/strict';
import test from 'node:test';
import { createBenchmarkRecord, compareBenchmarkSuites, diffExecutionSnapshots } from '../src/runtime/execution/benchmark.mjs';
import { ExecutionKernel } from '../src/runtime/execution/execution-kernel.mjs';

const definition = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });
const TOOLSET = ['cuppet_plan', 'tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate', 'workspace_read', 'workspace_edit', 'workspace_write', 'bash'].map(definition);

test('raw-baseline is benchmark-only and exposes the raw mediated surface', () => {
  const optimized = new ExecutionKernel();
  const raw = new ExecutionKernel({ benchmarkPolicy: 'raw-baseline' });
  const optimizedNames = optimized.toolsForProvider(TOOLSET, { sessionId: 'optimized' }).map((item) => item.function.name);
  const rawNames = raw.toolsForProvider(TOOLSET, { sessionId: 'raw' }).map((item) => item.function.name);

  assert.ok(optimizedNames.includes('tst_read'));
  assert.ok(optimizedNames.includes('tst_edit_batch'));
  assert.ok(optimizedNames.includes('cuppet_execute'));
  assert.ok(!optimizedNames.includes('workspace_read'));
  assert.ok(!optimizedNames.includes('workspace_write'));
  assert.ok(!optimizedNames.includes('bash'));

  assert.ok(rawNames.includes('workspace_read'));
  assert.ok(rawNames.includes('workspace_edit'));
  assert.ok(rawNames.includes('workspace_write'));
  assert.ok(rawNames.includes('bash'));
  assert.ok(!rawNames.includes('tst_read'));
  assert.ok(!rawNames.includes('tst_edit_batch'));
  assert.ok(!rawNames.includes('cuppet_execute'));
  assert.throws(() => new ExecutionKernel({ benchmarkPolicy: 'user-selectable-raw' }), /Unknown execution benchmark policy/);
});

test('ExecutionKernel benchmark metrics record batching, validation and per-tool calls', async () => {
  const kernel = new ExecutionKernel();
  await kernel.execute({
    id: 'read-1', name: 'tst_read', arguments: JSON.stringify({ reads: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
  }, {
    sessionId: 'bench',
    execute: async () => ({ success: true, output: 'compact', paths: ['a.ts', 'b.ts'], mutation: false }),
  });
  await kernel.execute({
    id: 'edit-1', name: 'tst_edit_batch', arguments: JSON.stringify({ operations: [{ op: 'x' }, { op: 'y' }, { op: 'z' }] }),
  }, {
    sessionId: 'bench',
    execute: async () => ({ success: true, output: 'edited', paths: ['a.ts', 'b.ts', 'c.ts'], mutation: true, validation: { success: true } }),
  });

  const snapshot = kernel.snapshot('bench');
  assert.equal(snapshot.policy, 'optimized');
  assert.equal(snapshot.toolCallsByName.tst_read, 1);
  assert.equal(snapshot.toolCallsByName.tst_edit_batch, 1);
  assert.equal(snapshot.batchReadTargets, 2);
  assert.equal(snapshot.maxBatchReadTargets, 2);
  assert.equal(snapshot.batchEditOperations, 3);
  assert.equal(snapshot.maxBatchEditOperations, 3);
  assert.equal(snapshot.validationAttempts, 1);
  assert.equal(snapshot.validationSuccesses, 1);
  assert.equal(snapshot.mutations, 1);
});

test('execution snapshot deltas isolate one benchmark task from session totals', () => {
  const before = {
    policy: 'optimized', executed: 4, optimizedExecuted: 3, outputBytes: 100, toolCallsByName: { tst_read: 2 }, maxBatchReadTargets: 2,
  };
  const after = {
    policy: 'optimized', executed: 7, optimizedExecuted: 6, outputBytes: 260, toolCallsByName: { tst_read: 4, tst_validate: 1 }, maxBatchReadTargets: 5,
  };
  const delta = diffExecutionSnapshots(before, after);
  assert.equal(delta.executed, 3);
  assert.equal(delta.optimizedExecuted, 3);
  assert.equal(delta.outputBytes, 160);
  assert.deepEqual(delta.toolCallsByName, { tst_read: 2, tst_validate: 1 });
  assert.equal(delta.maxBatchReadTargets, 5);
});

test('benchmark gate requires efficiency improvement without correctness regression', () => {
  const baseline = [createBenchmarkRecord({
    taskId: 'multi-file-change',
    providerID: 'opencode',
    modelID: 'model-a',
    mode: 'raw-baseline',
    correctness: { passed: true, score: 1 },
    metrics: {
      toolCalls: 12, optimizedCalls: 0, semanticCalls: 1, rawFallbackCalls: 11, optimizedPathShare: 0,
      rawReads: 5, shellCalls: 3, mutationExecutions: 4, fallbackUnlocks: 0, blockedBypassAttempts: 0,
      batchReadTargets: 0, batchEditOperations: 0, contextBytesReturned: 12000, pathsTouched: 9,
      executionMs: 900, elapsedMs: 1500, validationAttempts: 1, validationSuccesses: 1, validationFailures: 0,
      inputTokens: 1000, outputTokens: 300, totalTokens: 1300, cachedInputTokens: 0, reasoningTokens: 0,
    },
  })];
  const optimized = [createBenchmarkRecord({
    taskId: 'multi-file-change',
    providerID: 'opencode',
    modelID: 'model-a',
    mode: 'optimized',
    correctness: { passed: true, score: 1 },
    metrics: {
      toolCalls: 6, optimizedCalls: 4, semanticCalls: 2, rawFallbackCalls: 0, optimizedPathShare: 4 / 6,
      rawReads: 0, shellCalls: 1, mutationExecutions: 1, fallbackUnlocks: 0, blockedBypassAttempts: 0,
      batchReadTargets: 5, batchEditOperations: 4, contextBytesReturned: 5000, pathsTouched: 7,
      executionMs: 700, elapsedMs: 1200, validationAttempts: 1, validationSuccesses: 1, validationFailures: 0,
      inputTokens: 650, outputTokens: 250, totalTokens: 900, cachedInputTokens: 0, reasoningTokens: 0,
    },
  })];

  const comparison = compareBenchmarkSuites({ baseline, optimized });
  assert.equal(comparison.passed, true);
  assert.equal(comparison.tasksCompared, 1);
  assert.equal(comparison.correctnessRegressions.length, 0);
  assert.equal(comparison.optimizedPathImproved, true);
  assert.ok(comparison.improvements.length >= 2);

  const regression = compareBenchmarkSuites({
    baseline,
    optimized: [{ ...optimized[0], correctness: { passed: false, score: 0, details: 'wrong output' } }],
  });
  assert.equal(regression.passed, false);
  assert.match(regression.reasons.join('\n'), /optimized task failed while baseline passed/);
});
