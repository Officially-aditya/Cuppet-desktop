const OPTIMIZED_TOOLS = new Set(['tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate']);
const SEMANTIC_TOOLS = new Set(['cuppet_plan', 'cuppet_memory_search', 'question']);
const RAW_TOOLS = new Set(['workspace_read', 'workspace_edit', 'workspace_write', 'bash']);
const RAW_MUTATION_TOOLS = new Set(['workspace_edit', 'workspace_write']);

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
    const filtered = state.rawMutationFallback
      ? source
      : source.filter((definition) => !RAW_MUTATION_TOOLS.has(toolName(definition)));
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

    // ACP v1 can request host writes directly. When Cuppet's MCP tool surface is
    // available, do not let that native path silently bypass batched edits.
    // Raw mutation becomes an explicit fallback only after tst_edit_batch fails.
    if (call?.source === 'acp-host' && RAW_MUTATION_TOOLS.has(tool) && !state.rawMutationFallback) {
      state.blockedRawMutations += 1;
      const output = 'Cuppet optimized mutation path required. Use the cuppet-runtime MCP tool tst_edit_batch first; raw workspace mutation is enabled only if the optimized batch path fails.';
      this.#safeEmit({
        type: 'execution.kernel.blocked',
        sessionId: String(sessionId || ''),
        tool,
        path,
        reason: 'optimized-mutation-required',
      });
      return { success: false, output, contentItems: [], paths: [], mutation: false, validation: null };
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
      if (tool === 'tst_edit_batch' && result?.success !== true) this.#enableRawMutationFallback(sessionId, state, 'optimized-batch-failed');
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
      if (tool === 'tst_edit_batch') this.#enableRawMutationFallback(sessionId, state, 'optimized-batch-error');
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

  #enableRawMutationFallback(sessionId, state, reason) {
    if (state.rawMutationFallback) return;
    state.rawMutationFallback = true;
    this.#safeEmit({
      type: 'execution.kernel.fallback-enabled',
      sessionId: String(sessionId || ''),
      scope: 'raw-mutation',
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
  return { total: 0, optimized: 0, semantic: 0, 'raw-fallback': 0, 'provider-extension': 0, blockedRawMutations: 0, rawMutationFallback: false };
}
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
