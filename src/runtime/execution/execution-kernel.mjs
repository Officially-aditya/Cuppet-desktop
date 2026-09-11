const OPTIMIZED_TOOLS = new Set(['tst_explore', 'tst_read', 'tst_edit_batch', 'tst_validate']);
const SEMANTIC_TOOLS = new Set(['cuppet_plan', 'cuppet_memory_search', 'question']);
const RAW_TOOLS = new Set(['workspace_read', 'workspace_edit', 'workspace_write', 'bash']);

/**
 * Transport-neutral execution policy boundary.
 *
 * Providers request Cuppet tools; this kernel decides/records the execution path
 * before delegating to ToolRuntime. It deliberately starts as an identity router:
 * optimization behavior stays single-sourced in ToolRuntime while policy and
 * telemetry gain one universal interception point for ACP, Codex and future transports.
 */
export class ExecutionKernel {
  #emit;
  #now;
  #stats = new Map();

  constructor({ emit = () => {}, now = () => Date.now() } = {}) {
    this.#emit = typeof emit === 'function' ? emit : () => {};
    this.#now = typeof now === 'function' ? now : () => Date.now();
  }

  async execute(call, { sessionId = '', projectRoot = null, execute } = {}) {
    if (typeof execute !== 'function') throw new TypeError('ExecutionKernel requires an execute callback.');
    const tool = text(call?.name) || 'unknown';
    const path = executionPathForTool(tool);
    const startedAt = this.#now();
    const stats = this.#sessionStats(sessionId);
    stats.total += 1;
    stats[path] = (stats[path] ?? 0) + 1;

    this.#safeEmit({
      type: 'execution.kernel.started',
      sessionId: String(sessionId || ''),
      tool,
      path,
      projectBound: Boolean(projectRoot),
      startedAt,
      sequence: stats.total,
    });

    try {
      const result = await execute(call);
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
    const stats = this.#stats.get(String(sessionId || ''));
    return Object.freeze(stats ? { ...stats } : emptyStats());
  }

  forget(sessionId) {
    return this.#stats.delete(String(sessionId || ''));
  }

  #sessionStats(sessionId) {
    const id = String(sessionId || '');
    let stats = this.#stats.get(id);
    if (!stats) {
      stats = emptyStats();
      this.#stats.set(id, stats);
    }
    return stats;
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

function emptyStats() {
  return { total: 0, optimized: 0, semantic: 0, 'raw-fallback': 0, 'provider-extension': 0 };
}
function cleanError(error) { return (error instanceof Error ? error.message : String(error ?? '')).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
