const OPTIMIZED_TOOLS = new Set(['tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate']);
const SEMANTIC_TOOLS = new Set(['cuppet_plan', 'cuppet_memory_search', 'question']);
const RAW_TOOLS = new Set(['workspace_read', 'workspace_edit', 'workspace_write', 'bash']);
const RAW_MUTATION_TOOLS = new Set(['workspace_edit', 'workspace_write']);
const RAW_READ_TOOLS = new Set(['workspace_read']);

/**
 * Transport-neutral execution policy boundary.
 *
 * Providers request Cuppet operations; this kernel controls which execution
 * surface is advertised and records/guards the path before delegating to
 * ToolRuntime. ACP, Codex and future transports all cross this same boundary.
 */
export class ExecutionKernel {
  #emit;
  #now;
  #states = new Map();

  constructor({ emit = () => {}, now = () => Date.now() } = {}) {
    this.#emit = typeof emit === 'function' ? emit : () => {};
    this.#now = typeof now === 'function' ? now : () => Date.now();
  }

  toolsForProvider(definitions, { sessionId = '' } = {}) {
    const state = this.#sessionState(sessionId);
    const source = Array.isArray(definitions) ? definitions : [];
    const filtered = source.filter((definition) => {
      const name = toolName(definition);
      if (!state.rawMutationFallback && RAW_MUTATION_TOOLS.has(name)) return false;
      if (!state.rawReadFallback && RAW_READ_TOOLS.has(name)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => toolPriority(toolName(a)) - toolPriority(toolName(b)));
  }

  async execute(call, { sessionId = '', projectRoot = null, execute } = {}) {
    if (typeof execute !== 'function') throw new TypeError('ExecutionKernel requires an execute callback.');
    const tool = text(call?.name) || 'unknown';
    const path = executionPathForTool(tool);
    const startedAt = this.#now();
    const state = this.#sessionState(sessionId);
    state.total += 1;
    state[path] = (state[path] ?? 0) + 1;

    // ACP v1 can request host filesystem operations directly. Do not let those
    // native calls silently bypass Cuppet's structured/bounded read and batch-edit
    // paths. Raw fallback unlocks only after the corresponding optimized tool fails.
    if (call?.source === 'acp-host' && RAW_MUTATION_TOOLS.has(tool) && !state.rawMutationFallback) {
      state.blockedRawMutations += 1;
      return this.#blockedResult({
        sessionId,
        tool,
        path,
        reason: 'optimized-mutation-required',
        output: 'Cuppet optimized mutation path required. Use the cuppet-runtime MCP tool tst_edit_batch first; raw workspace mutation is enabled only if the optimized batch path fails.',
      });
    }
    if (call?.source === 'acp-host' && RAW_READ_TOOLS.has(tool) && !state.rawReadFallback) {
      state.blockedRawReads += 1;
      return this.#blockedResult({
        sessionId,
        tool,
        path,
        reason: 'optimized-read-required',
        output: 'Cuppet optimized read path required. Use the cuppet-runtime MCP tools tst_explore/tst_read first; raw workspace reads are enabled only if the structured read path fails.',
      });
    }

    this.#safeEmit({
      type: 'execution.kernel.started',
      sessionId: String(sessionId || ''),
      tool,
      path,
      projectBound: Boolean(projectRoot),
      startedAt,
      sequence: state.total,
    });

    try {
      const result = await execute(call);
      if (tool === 'tst_edit_batch' && result?.success !== true) this.#enableFallback(sessionId, state, 'rawMutationFallback', 'raw-mutation', 'optimized-batch-failed');
      if (tool === 'tst_read' && result?.success !== true) this.#enableFallback(sessionId, state, 'rawReadFallback', 'raw-read', 'optimized-read-failed');
      this.#safeEmit({
        type: 'execution.kernel.completed',
        sessionId: String(sessionId || ''),
        tool,
        path,
        success: result?.success === true,
        durationMs: Math.max(0, this.#now() - startedAt),
      });
      return result;
    } catch (error) {
      if (tool === 'tst_edit_batch') this.#enableFallback(sessionId, state, 'rawMutationFallback', 'raw-mutation', 'optimized-batch-error');
      if (tool === 'tst_read') this.#enableFallback(sessionId, state, 'rawReadFallback', 'raw-read', 'optimized-read-error');
      this.#safeEmit({
        type: 'execution.kernel.completed',
        sessionId: String(sessionId || ''),
        tool,
        path,
        success: false,
        durationMs: Math.max(0, this.#now() - startedAt),
        error: cleanError(error),
      });
      throw error;
    }
  }

  snapshot(sessionId) {
    const state = this.#states.get(String(sessionId || ''));
    return Object.freeze(state ? { ...state } : emptyState());
  }

  forget(sessionId) {
    return this.#states.delete(String(sessionId || ''));
  }

  #sessionState(sessionId) {
    const id = String(sessionId || '');
    let state = this.#states.get(id);
    if (!state) {
      state = emptyState();
      this.#states.set(id, state);
    }
    return state;
  }

  #blockedResult({ sessionId, tool, path, reason, output }) {
    this.#safeEmit({
      type: 'execution.kernel.blocked',
      sessionId: String(sessionId || ''),
      tool,
      path,
      reason,
    });
    return { success: false, output, contentItems: [], paths: [], mutation: false, validation: null };
  }

  #enableFallback(sessionId, state, key, scope, reason) {
    if (state[key]) return;
    state[key] = true;
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

function toolPriority(name) {
  const path = executionPathForTool(name);
  if (path === 'optimized') return 0;
  if (path === 'semantic') return 1;
  if (path === 'provider-extension') return 2;
  return 3;
}
function toolName(definition) { return text(definition?.function?.name ?? definition?.name); }
function emptyState() {
  return {
    total: 0,
    optimized: 0,
    semantic: 0,
    'raw-fallback': 0,
    'provider-extension': 0,
    blockedRawMutations: 0,
    blockedRawReads: 0,
    rawMutationFallback: false,
    rawReadFallback: false,
  };
}
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
