const NUMERIC_EXECUTION_FIELDS = [
  'total', 'optimized', 'semantic', 'raw-fallback', 'provider-extension',
  'executed', 'completed', 'successes', 'failures',
  'optimizedExecuted', 'semanticExecuted', 'rawFallbackExecuted', 'providerExtensionExecuted',
  'optimizedSuccesses', 'semanticSuccesses', 'rawFallbackSuccesses', 'providerExtensionSuccesses',
  'optimizedFailures', 'semanticFailures', 'rawFallbackFailures', 'providerExtensionFailures',
  'durationMs', 'outputBytes', 'pathsTouched', 'mutations', 'fallbackUnlocks',
  'blockedRawMutations', 'blockedRawReads', 'blockedNativeShell', 'blockedShellMutations', 'blockedShellReads',
  'batchReadTargets', 'maxBatchReadTargets', 'batchEditOperations', 'maxBatchEditOperations',
  'validationAttempts', 'validationSuccesses', 'validationFailures',
];

const LOWER_IS_BETTER = [
  'toolCalls',
  'rawReads',
  'shellCalls',
  'mutationExecutions',
  'contextBytesReturned',
  'totalTokens',
];

export async function captureBenchmarkTask({
  runtime,
  runOptions,
  taskId,
  providerID,
  modelID,
  mode = null,
  verify = async () => ({ passed: true }),
  now = () => Date.now(),
} = {}) {
  if (!runtime || typeof runtime.run !== 'function' || typeof runtime.executionSnapshot !== 'function') {
    throw new TypeError('captureBenchmarkTask requires a JournaledToolRuntime-like runtime.');
  }
  const sessionId = requiredText(runOptions?.sessionId, 'runOptions.sessionId');
  const before = runtime.executionSnapshot(sessionId) ?? {};
  const startedAt = now();
  let result = null;
  let runError = null;
  try {
    result = await runtime.run(runOptions);
  } catch (error) {
    runError = error;
  }
  const elapsedMs = Math.max(0, now() - startedAt);
  const after = runtime.executionSnapshot(sessionId) ?? {};
  const execution = diffExecutionSnapshots(before, after);
  let verification;
  if (runError) {
    verification = { passed: false, details: cleanError(runError) };
  } else {
    try {
      verification = normalizeCorrectness(await verify({ result, execution, sessionId }));
    } catch (error) {
      verification = { passed: false, details: `Verification failed: ${cleanError(error)}` };
    }
  }
  return createBenchmarkRecord({
    taskId,
    providerID,
    modelID,
    mode: mode ?? execution.policy,
    execution,
    usage: result?.usage,
    elapsedMs,
    correctness: verification,
    ...(runError ? { error: cleanError(runError) } : {}),
  });
}

export function diffExecutionSnapshots(before = {}, after = {}) {
  const left = record(before);
  const right = record(after);
  const output = {
    policy: text(right.policy) || text(left.policy) || 'optimized',
    toolCallsByName: diffNamedCounters(left.toolCallsByName, right.toolCallsByName),
    rawMutationFallback: Boolean(right.rawMutationFallback),
    rawReadFallback: Boolean(right.rawReadFallback),
  };
  for (const key of NUMERIC_EXECUTION_FIELDS) {
    if (key === 'maxBatchReadTargets' || key === 'maxBatchEditOperations') {
      output[key] = number(right[key]);
      continue;
    }
    output[key] = Math.max(0, number(right[key]) - number(left[key]));
  }
  return Object.freeze({ ...output, toolCallsByName: Object.freeze(output.toolCallsByName) });
}

export function createBenchmarkRecord({
  taskId,
  providerID = 'unknown',
  modelID = 'unknown',
  mode = 'optimized',
  execution = {},
  usage = null,
  elapsedMs = 0,
  correctness = { passed: true },
  error = null,
} = {}) {
  const state = record(execution);
  const tools = record(state.toolCallsByName);
  const tokens = normalizeUsage(usage);
  const executed = number(state.executed);
  const optimizedExecuted = number(state.optimizedExecuted);
  const validationAttempts = number(state.validationAttempts);
  const validationSuccesses = number(state.validationSuccesses);
  const metrics = Object.freeze({
    toolCalls: executed,
    optimizedCalls: optimizedExecuted,
    semanticCalls: number(state.semanticExecuted),
    rawFallbackCalls: number(state.rawFallbackExecuted),
    optimizedPathShare: executed > 0 ? optimizedExecuted / executed : 0,
    rawReads: number(tools.workspace_read),
    shellCalls: number(tools.bash) + number(tools.cuppet_execute),
    mutationExecutions: number(state.mutations),
    fallbackUnlocks: number(state.fallbackUnlocks),
    blockedBypassAttempts: number(state.blockedRawMutations) + number(state.blockedRawReads) + number(state.blockedNativeShell) + number(state.blockedShellMutations) + number(state.blockedShellReads),
    batchReadTargets: number(state.batchReadTargets),
    maxBatchReadTargets: number(state.maxBatchReadTargets),
    batchEditOperations: number(state.batchEditOperations),
    maxBatchEditOperations: number(state.maxBatchEditOperations),
    contextBytesReturned: number(state.outputBytes),
    pathsTouched: number(state.pathsTouched),
    executionMs: number(state.durationMs),
    elapsedMs: Math.max(0, number(elapsedMs)),
    validationAttempts,
    validationSuccesses,
    validationFailures: number(state.validationFailures),
    validationPassRate: validationAttempts > 0 ? validationSuccesses / validationAttempts : null,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    reasoningTokens: tokens.reasoningTokens,
  });
  return Object.freeze({
    schemaVersion: 1,
    taskId: requiredText(taskId, 'taskId'),
    providerID: text(providerID) || 'unknown',
    modelID: text(modelID) || 'unknown',
    mode: mode === 'raw-baseline' ? 'raw-baseline' : 'optimized',
    correctness: Object.freeze(normalizeCorrectness(correctness)),
    metrics,
    ...(error ? { error: String(error).slice(0, 1000) } : {}),
  });
}

export function compareBenchmarkSuites({ baseline = [], optimized = [], minImprovements = 2 } = {}) {
  const rawRecords = normalizeRecordArray(baseline, 'raw-baseline');
  const optimizedRecords = normalizeRecordArray(optimized, 'optimized');
  const baselineByTask = new Map(rawRecords.map((record) => [record.taskId, record]));
  const optimizedByTask = new Map(optimizedRecords.map((record) => [record.taskId, record]));
  const taskIds = [...new Set([...baselineByTask.keys(), ...optimizedByTask.keys()])].sort();
  const missingBaseline = taskIds.filter((id) => !baselineByTask.has(id));
  const missingOptimized = taskIds.filter((id) => !optimizedByTask.has(id));
  const correctnessRegressions = [];
  const taskComparisons = [];

  for (const taskId of taskIds) {
    const base = baselineByTask.get(taskId);
    const next = optimizedByTask.get(taskId);
    if (!base || !next) continue;
    const baseScore = correctnessScore(base.correctness);
    const nextScore = correctnessScore(next.correctness);
    if (base.correctness.passed && !next.correctness.passed) correctnessRegressions.push(`${taskId}: optimized task failed while baseline passed`);
    else if (nextScore + 1e-9 < baseScore) correctnessRegressions.push(`${taskId}: correctness score ${nextScore} < baseline ${baseScore}`);
    taskComparisons.push(Object.freeze({
      taskId,
      correctnessDelta: nextScore - baseScore,
      metrics: metricDeltas(base.metrics, next.metrics),
    }));
  }

  const baselineAggregate = aggregateMetrics(rawRecords);
  const optimizedAggregate = aggregateMetrics(optimizedRecords);
  const improvements = LOWER_IS_BETTER.flatMap((key) => {
    const before = number(baselineAggregate[key]);
    const after = number(optimizedAggregate[key]);
    if (before <= 0 || after >= before) return [];
    return [{ metric: key, before, after, reduction: (before - after) / before }];
  });
  const optimizedPathImproved = optimizedAggregate.optimizedPathShare > baselineAggregate.optimizedPathShare;
  const reasons = [];
  if (missingBaseline.length) reasons.push(`Missing baseline tasks: ${missingBaseline.join(', ')}`);
  if (missingOptimized.length) reasons.push(`Missing optimized tasks: ${missingOptimized.join(', ')}`);
  reasons.push(...correctnessRegressions);
  if (!optimizedPathImproved) reasons.push('Optimized execution did not increase optimized-path share.');
  if (improvements.length < Math.max(1, Number(minImprovements) || 2)) {
    reasons.push(`Only ${improvements.length} efficiency metric(s) improved; benchmark gate requires ${Math.max(1, Number(minImprovements) || 2)}.`);
  }
  const passed = reasons.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    passed,
    tasksCompared: taskComparisons.length,
    missingBaseline: Object.freeze(missingBaseline),
    missingOptimized: Object.freeze(missingOptimized),
    correctnessRegressions: Object.freeze(correctnessRegressions),
    optimizedPathImproved,
    improvements: Object.freeze(improvements.map((item) => Object.freeze(item))),
    baseline: Object.freeze(baselineAggregate),
    optimized: Object.freeze(optimizedAggregate),
    taskComparisons: Object.freeze(taskComparisons),
    reasons: Object.freeze(reasons),
  });
}

function aggregateMetrics(records) {
  const totals = {
    tasks: records.length,
    correctnessPassed: 0,
    correctnessScore: 0,
    toolCalls: 0,
    optimizedCalls: 0,
    semanticCalls: 0,
    rawFallbackCalls: 0,
    rawReads: 0,
    shellCalls: 0,
    mutationExecutions: 0,
    fallbackUnlocks: 0,
    blockedBypassAttempts: 0,
    batchReadTargets: 0,
    batchEditOperations: 0,
    contextBytesReturned: 0,
    pathsTouched: 0,
    executionMs: 0,
    elapsedMs: 0,
    validationAttempts: 0,
    validationSuccesses: 0,
    validationFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  for (const record of records) {
    totals.correctnessPassed += record.correctness.passed ? 1 : 0;
    totals.correctnessScore += correctnessScore(record.correctness);
    for (const key of Object.keys(totals)) {
      if (['tasks', 'correctnessPassed', 'correctnessScore'].includes(key)) continue;
      totals[key] += number(record.metrics?.[key]);
    }
  }
  totals.optimizedPathShare = totals.toolCalls > 0 ? totals.optimizedCalls / totals.toolCalls : 0;
  totals.validationPassRate = totals.validationAttempts > 0 ? totals.validationSuccesses / totals.validationAttempts : null;
  totals.correctnessRate = totals.tasks > 0 ? totals.correctnessPassed / totals.tasks : 0;
  totals.averageCorrectnessScore = totals.tasks > 0 ? totals.correctnessScore / totals.tasks : 0;
  return totals;
}

function metricDeltas(before, after) {
  const keys = [...new Set([...Object.keys(record(before)), ...Object.keys(record(after))])].sort();
  return Object.fromEntries(keys.flatMap((key) => {
    const left = before?.[key];
    const right = after?.[key];
    if (typeof left !== 'number' || typeof right !== 'number') return [];
    return [[key, right - left]];
  }));
}

function diffNamedCounters(before, after) {
  const left = record(before);
  const right = record(after);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...keys].sort().flatMap((key) => {
    const value = Math.max(0, number(right[key]) - number(left[key]));
    return value ? [[key, value]] : [];
  }));
}

function normalizeRecordArray(value, mode) {
  return (Array.isArray(value) ? value : []).map((item) => createBenchmarkRecord({ ...record(item), mode }));
}

function normalizeUsage(value) {
  const source = record(value);
  const inputTokens = number(source.inputTokens ?? source.input_tokens);
  const outputTokens = number(source.outputTokens ?? source.output_tokens);
  const explicitTotal = number(source.totalTokens ?? source.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal || inputTokens + outputTokens,
    cachedInputTokens: number(source.cachedInputTokens ?? source.cached_input_tokens ?? source.cachedReadTokens),
    reasoningTokens: number(source.reasoningTokens ?? source.reasoning_tokens),
  };
}

function normalizeCorrectness(value) {
  if (typeof value === 'boolean') return { passed: value, score: value ? 1 : 0 };
  const source = record(value);
  const passed = source.passed !== false;
  const explicitScore = Number(source.score);
  return {
    passed,
    score: Number.isFinite(explicitScore) ? Math.max(0, Math.min(1, explicitScore)) : passed ? 1 : 0,
    ...(text(source.details) ? { details: text(source.details).slice(0, 2000) } : {}),
  };
}

function correctnessScore(value) {
  const source = normalizeCorrectness(value);
  return source.passed ? source.score : Math.min(source.score, 0);
}
function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function requiredText(value, label) { const result = text(value); if (!result) throw new TypeError(`${label} is required.`); return result; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? 'Unknown error')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 1000); }
