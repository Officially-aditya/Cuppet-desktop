const OPTIMIZED_TOOLS = new Set(['tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate']);
const SEMANTIC_TOOLS = new Set(['cuppet_plan', 'cuppet_memory_search', 'question', 'cuppet_execute']);
const RAW_TOOLS = new Set(['workspace_read', 'workspace_edit', 'workspace_write', 'bash']);
const RAW_MUTATION_TOOLS = new Set(['workspace_edit', 'workspace_write']);
const RAW_READ_TOOLS = new Set(['workspace_read']);
const EXECUTION_POLICIES = new Set(['optimized', 'raw-baseline']);

/**
 * Transport-neutral execution policy boundary.
 *
 * Providers request Cuppet operations; this kernel controls which execution
 * surface is advertised and records/guards the path before delegating to
 * ToolRuntime. ACP, Codex and future transports all cross this same boundary.
 *
 * `raw-baseline` exists only for controlled benchmark harnesses. Product
 * sessions construct the default `optimized` policy and must never surface a
 * user preference that weakens optimized-first execution.
 */
export class ExecutionKernel {
  #emit;
  #now;
  #policy;
  #states = new Map();

  constructor({ emit = () => {}, now = () => Date.now(), benchmarkPolicy = 'optimized' } = {}) {
    if (!EXECUTION_POLICIES.has(benchmarkPolicy)) throw new TypeError(`Unknown execution benchmark policy: ${String(benchmarkPolicy)}`);
    this.#emit = typeof emit === 'function' ? emit : () => {};
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#policy = benchmarkPolicy;
  }

  toolsForProvider(definitions, { sessionId = '' } = {}) {
    const state = this.#sessionState(sessionId);
    const rawBaseline = this.#policy === 'raw-baseline';
    const source = (Array.isArray(definitions) ? definitions : []).map(rawBaseline ? cloneDefinition : providerFacingDefinition);
    const filtered = source.filter((definition) => {
      const name = toolName(definition);
      if (rawBaseline) return !OPTIMIZED_TOOLS.has(name) && name !== 'cuppet_execute';
      if (!state.rawMutationFallback && RAW_MUTATION_TOOLS.has(name)) return false;
      if (!state.rawReadFallback && RAW_READ_TOOLS.has(name)) return false;
      return name !== 'bash';
    });
    return [...filtered].sort((a, b) => toolPriority(toolName(a)) - toolPriority(toolName(b)));
  }

  async execute(call, { sessionId = '', projectRoot = null, execute } = {}) {
    if (typeof execute !== 'function') throw new TypeError('ExecutionKernel requires an execute callback.');
    const tool = text(call?.name) || 'unknown';
    const path = executionPathForTool(tool);
    const startedAt = this.#now();
    const state = this.#sessionState(sessionId);
    const rawBaseline = this.#policy === 'raw-baseline';
    state.total += 1;
    state[path] = (state[path] ?? 0) + 1;
    this.#recordRequest(state, tool, call);

    // Managed ACP must use Cuppet's semantic command operation rather than the
    // protocol's native terminal path. The benchmark-only raw baseline keeps
    // the old mediated host path so we can measure the optimization delta.
    if (!rawBaseline && call?.source === 'acp-host' && tool === 'bash') {
      state.blockedNativeShell += 1;
      return this.#blockedResult({
        sessionId,
        tool,
        path,
        reason: 'cuppet-execute-required',
        output: 'Cuppet command mediation required. Use the cuppet-runtime MCP tool cuppet_execute instead of the native ACP terminal.',
      });
    }

    // ACP v1 can request host filesystem operations directly. Do not let those
    // native calls silently bypass Cuppet's structured/bounded read and batch-edit
    // paths. Raw fallback unlocks only after the corresponding optimized tool fails.
    if (!rawBaseline && call?.source === 'acp-host' && RAW_MUTATION_TOOLS.has(tool) && !state.rawMutationFallback) {
      state.blockedRawMutations += 1;
      return this.#blockedResult({
        sessionId,
        tool,
        path,
        reason: 'optimized-mutation-required',
        output: 'Cuppet optimized mutation path required. Use the cuppet-runtime MCP tool tst_edit_batch first; raw workspace mutation is enabled only if the optimized batch path fails.',
      });
    }
    if (!rawBaseline && call?.source === 'acp-host' && RAW_READ_TOOLS.has(tool) && !state.rawReadFallback) {
      state.blockedRawReads += 1;
      return this.#blockedResult({
        sessionId,
        tool,
        path,
        reason: 'optimized-read-required',
        output: 'Cuppet optimized read path required. Use the cuppet-runtime MCP tools tst_explore/tst_read first; raw workspace reads are enabled only if the structured read path fails.',
      });
    }

    let executionCall = call;
    if (tool === 'cuppet_execute') {
      const command = commandFromCall(call);
      const bypass = shellWorkspaceBypass(command);
      if (!rawBaseline && bypass === 'mutation' && !state.rawMutationFallback) {
        state.blockedShellMutations += 1;
        return this.#blockedResult({
          sessionId,
          tool,
          path,
          reason: 'optimized-mutation-required',
          output: 'Direct source mutation through shell is blocked while Cuppet batched editing is available. Use tst_edit_batch first; shell mutation becomes eligible only after the optimized mutation path fails.',
        });
      }
      if (!rawBaseline && bypass === 'read' && !state.rawReadFallback) {
        state.blockedShellReads += 1;
        return this.#blockedResult({
          sessionId,
          tool,
          path,
          reason: 'optimized-read-required',
          output: 'Direct source inspection through shell is blocked while Cuppet structured retrieval is available. Use tst_explore/tst_read first; shell file inspection becomes eligible only after the structured read path fails.',
        });
      }
      executionCall = { ...call, name: 'bash', source: 'cuppet-execute' };
    }

    state.executed += 1;
    state[executedPathKey(path)] += 1;
    this.#safeEmit({
      type: 'execution.kernel.started',
      sessionId: String(sessionId || ''),
      tool,
      path,
      policy: this.#policy,
      projectBound: Boolean(projectRoot),
      startedAt,
      sequence: state.total,
    });

    try {
      const result = await execute(executionCall);
      const durationMs = Math.max(0, this.#now() - startedAt);
      const success = result?.success === true;
      if (!rawBaseline && tool === 'tst_edit_batch' && !success) this.#enableFallback(sessionId, state, 'rawMutationFallback', 'raw-mutation', 'optimized-batch-failed');
      if (!rawBaseline && tool === 'tst_read' && !success) this.#enableFallback(sessionId, state, 'rawReadFallback', 'raw-read', 'optimized-read-failed');
      this.#recordOutcome(state, { path, result, success, durationMs });
      this.#safeEmit({
        type: 'execution.kernel.completed',
        sessionId: String(sessionId || ''),
        tool,
        path,
        policy: this.#policy,
        success,
        durationMs,
        outputBytes: outputBytes(result),
        pathsTouched: resultPaths(result).length,
        mutation: result?.mutation === true,
      });
      return result;
    } catch (error) {
      const durationMs = Math.max(0, this.#now() - startedAt);
      if (!rawBaseline && tool === 'tst_edit_batch') this.#enableFallback(sessionId, state, 'rawMutationFallback', 'raw-mutation', 'optimized-batch-error');
      if (!rawBaseline && tool === 'tst_read') this.#enableFallback(sessionId, state, 'rawReadFallback', 'raw-read', 'optimized-read-error');
      this.#recordOutcome(state, { path, result: null, success: false, durationMs });
      this.#safeEmit({
        type: 'execution.kernel.completed',
        sessionId: String(sessionId || ''),
        tool,
        path,
        policy: this.#policy,
        success: false,
        durationMs,
        outputBytes: 0,
        pathsTouched: 0,
        mutation: false,
        error: cleanError(error),
      });
      throw error;
    }
  }

  snapshot(sessionId) {
    const state = this.#states.get(String(sessionId || ''));
    const value = state ? { ...state, toolCallsByName: { ...state.toolCallsByName } } : emptyState(this.#policy);
    return Object.freeze({ ...value, toolCallsByName: Object.freeze({ ...value.toolCallsByName }) });
  }

  forget(sessionId) {
    return this.#states.delete(String(sessionId || ''));
  }

  #sessionState(sessionId) {
    const id = String(sessionId || '');
    let state = this.#states.get(id);
    if (!state) {
      state = emptyState(this.#policy);
      this.#states.set(id, state);
    }
    return state;
  }

  #recordRequest(state, tool, call) {
    state.toolCallsByName[tool] = (state.toolCallsByName[tool] ?? 0) + 1;
    const args = callArguments(call);
    if (tool === 'tst_read') {
      const targets = (text(args.path) ? 1 : 0) + array(args.reads).length + array(args.targets).length;
      state.batchReadTargets += targets;
      state.maxBatchReadTargets = Math.max(state.maxBatchReadTargets, targets);
    }
    if (tool === 'tst_edit_batch') {
      const operations = array(args.operations).length;
      state.batchEditOperations += operations;
      state.maxBatchEditOperations = Math.max(state.maxBatchEditOperations, operations);
    }
  }

  #recordOutcome(state, { path, result, success, durationMs }) {
    state.completed += 1;
    state.durationMs += durationMs;
    state.outputBytes += outputBytes(result);
    state.pathsTouched += resultPaths(result).length;
    if (result?.mutation === true) state.mutations += 1;
    const validation = record(result?.validation);
    if (Object.keys(validation).length) {
      state.validationAttempts += 1;
      if (validation.success === true) state.validationSuccesses += 1;
      else if (validation.success === false) state.validationFailures += 1;
    }
    if (success) {
      state.successes += 1;
      state[successPathKey(path)] += 1;
    } else {
      state.failures += 1;
      state[failurePathKey(path)] += 1;
    }
  }

  #blockedResult({ sessionId, tool, path, reason, output }) {
    this.#safeEmit({
      type: 'execution.kernel.blocked',
      sessionId: String(sessionId || ''),
      tool,
      path,
      policy: this.#policy,
      reason,
    });
    return { success: false, output, contentItems: [], paths: [], mutation: false, validation: null };
  }

  #enableFallback(sessionId, state, key, scope, reason) {
    if (state[key]) return;
    state[key] = true;
    state.fallbackUnlocks += 1;
    this.#safeEmit({
      type: 'execution.kernel.fallback-enabled',
      sessionId: String(sessionId || ''),
      scope,
      reason,
    });
  }

  #safeEmit(event) {
    try { this.#emit(event); } catch {}
  }
}

export function executionPathForTool(value) {
  const tool = text(value);
  if (OPTIMIZED_TOOLS.has(tool)) return 'optimized';
  if (SEMANTIC_TOOLS.has(tool) || tool.startsWith('browser_')) return 'semantic';
  if (RAW_TOOLS.has(tool)) return 'raw-fallback';
  return 'provider-extension';
}

function providerFacingDefinition(definition) {
  if (toolName(definition) !== 'bash') return cloneDefinition(definition);
  const fn = record(definition?.function);
  return {
    ...definition,
    function: {
      ...fn,
      name: 'cuppet_execute',
      description: 'Run a project command through Cuppet for builds, tests, package/tooling operations, generators, or other command execution. Do not use it to inspect source files or directly edit source while tst_explore/tst_read/tst_edit_batch are available.',
    },
  };
}

function cloneDefinition(definition) {
  const source = record(definition);
  return { ...source, ...(source.function && typeof source.function === 'object' ? { function: { ...source.function } } : {}) };
}

function shellWorkspaceBypass(command) {
  const source = String(command ?? '').trim();
  if (!source) return null;
  if (looksLikeShellMutation(source)) return 'mutation';
  if (looksLikeShellRead(source)) return 'read';
  return null;
}

function looksLikeShellMutation(source) {
  if (/(^|[^<])>{1,2}(?!>)/.test(source)) return true;
  if (/\b(?:rm|rmdir|unlink|mv|cp|touch|truncate|tee|patch)\b/i.test(source)) return true;
  if (/\bsed\b[^\n;&|]*\s-i(?:\s|$)/i.test(source) || /\bperl\b[^\n;&|]*\s-(?:p?i|i?p)\b/i.test(source)) return true;
  if (/\bgit\s+(?:add|checkout|switch|restore|reset|clean|apply|am|commit|merge|rebase|cherry-pick|rm|mv)\b/i.test(source)) return true;
  if (/\b(?:python\d*|node|ruby|perl)\b[^\n;&|]*(?:-c|-e)\b[^\n;&|]*(?:write|append|unlink|rename|mkdir|rmdir|remove|open\s*\()/i.test(source)) return true;
  return false;
}

function looksLikeShellRead(source) {
  if (/\b(?:cat|head|tail|less|more|grep|rg|ripgrep|find|fd|tree|awk)\b/i.test(source)) return true;
  if (/\bsed\b(?![^\n;&|]*\s-i(?:\s|$))/i.test(source)) return true;
  if (/\bgit\s+(?:grep|show|diff|blame)\b/i.test(source)) return true;
  if (/\b(?:python\d*|node|ruby|perl)\b[^\n;&|]*(?:-c|-e)\b[^\n;&|]*(?:readFile|read_to_string|File\.read|open\s*\()/i.test(source)) return true;
  return false;
}

function commandFromCall(call) {
  return text(callArguments(call).command);
}

function callArguments(call) {
  try {
    const parsed = JSON.parse(typeof call?.arguments === 'string' ? call.arguments : '{}');
    return record(parsed);
  } catch { return {}; }
}

function toolPriority(name) {
  const path = executionPathForTool(name);
  if (path === 'optimized') return 0;
  if (path === 'semantic') return 1;
  if (path === 'provider-extension') return 2;
  return 3;
}
function toolName(definition) { return text(definition?.function?.name ?? definition?.name); }
function executedPathKey(path) {
  if (path === 'optimized') return 'optimizedExecuted';
  if (path === 'semantic') return 'semanticExecuted';
  if (path === 'raw-fallback') return 'rawFallbackExecuted';
  return 'providerExtensionExecuted';
}
function successPathKey(path) {
  if (path === 'optimized') return 'optimizedSuccesses';
  if (path === 'semantic') return 'semanticSuccesses';
  if (path === 'raw-fallback') return 'rawFallbackSuccesses';
  return 'providerExtensionSuccesses';
}
function failurePathKey(path) {
  if (path === 'optimized') return 'optimizedFailures';
  if (path === 'semantic') return 'semanticFailures';
  if (path === 'raw-fallback') return 'rawFallbackFailures';
  return 'providerExtensionFailures';
}
function resultPaths(result) { return Array.isArray(result?.paths) ? result.paths : []; }
function outputBytes(result) { return Buffer.byteLength(typeof result?.output === 'string' ? result.output : '', 'utf8'); }
function emptyState(policy = 'optimized') {
  return {
    policy,
    total: 0,
    optimized: 0,
    semantic: 0,
    'raw-fallback': 0,
    'provider-extension': 0,
    executed: 0,
    completed: 0,
    successes: 0,
    failures: 0,
    optimizedExecuted: 0,
    semanticExecuted: 0,
    rawFallbackExecuted: 0,
    providerExtensionExecuted: 0,
    optimizedSuccesses: 0,
    semanticSuccesses: 0,
    rawFallbackSuccesses: 0,
    providerExtensionSuccesses: 0,
    optimizedFailures: 0,
    semanticFailures: 0,
    rawFallbackFailures: 0,
    providerExtensionFailures: 0,
    durationMs: 0,
    outputBytes: 0,
    pathsTouched: 0,
    mutations: 0,
    fallbackUnlocks: 0,
    blockedRawMutations: 0,
    blockedRawReads: 0,
    blockedNativeShell: 0,
    blockedShellMutations: 0,
    blockedShellReads: 0,
    rawMutationFallback: false,
    rawReadFallback: false,
    toolCallsByName: {},
    batchReadTargets: 0,
    maxBatchReadTargets: 0,
    batchEditOperations: 0,
    maxBatchEditOperations: 0,
    validationAttempts: 0,
    validationSuccesses: 0,
    validationFailures: 0,
  };
}
function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
