import { providerActivity } from '../../activity.mjs';

const TERMINAL_STATUSES = new Set(['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled']);
const FAILED_STATUSES = new Set(['failed', 'error']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

export class AcpActivityNormalizer {
  #toolStates = new Map();

  normalize(update) {
    const source = record(update);
    const kind = normalizeName(source.sessionUpdate ?? source.type ?? source.kind);
    if (kind === 'agent_message_chunk') {
      const value = contentText(source.content);
      return value ? providerActivity('activity.text.delta', { text: value }) : null;
    }
    if (kind === 'agent_thought_chunk') {
      const value = contentText(source.content);
      return value ? providerActivity('activity.reasoning.delta', { text: value }) : null;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') return this.#tool(source);
    if (kind === 'plan' || kind === 'plan_update' || kind === 'plan_updated') {
      const value = contentText(source.content ?? source.plan);
      return value ? providerActivity('activity.plan.updated', { text: value }) : null;
    }
    return null;
  }

  #tool(source) {
    const callId = text(source.toolCallId || source.tool_call_id || source.id);
    if (!callId) return null;
    const status = normalizeName(source.status);
    const previous = this.#toolStates.get(callId);
    const tool = text(source.title) || text(source.kind) || previous?.tool || 'agent-tool';
    const argumentsJson = boundedJson(source.rawInput ?? source.raw_input ?? source.input ?? {}, 20_000);
    const details = boundedDetail(source.content ?? source.rawOutput ?? source.raw_output ?? source.output, 8_000);
    const base = { callId, tool, label: tool, ...(argumentsJson ? { argumentsJson } : {}), ...(details ? { details } : {}) };

    if (TERMINAL_STATUSES.has(status)) {
      this.#toolStates.delete(callId);
      return providerActivity('activity.tool.closed', {
        ...base,
        status: CANCELLED_STATUSES.has(status) ? 'cancelled' : FAILED_STATUSES.has(status) ? 'error' : 'success',
      });
    }

    const type = previous ? 'activity.tool.updated' : 'activity.tool.opened';
    this.#toolStates.set(callId, { tool, status });
    return providerActivity(type, base);
  }
}

function contentText(value) { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(contentText).join(''); return typeof value?.text === 'string' ? value.text : ''; }
function boundedDetail(value, limit) { const raw = typeof value === 'string' ? value : value == null ? '' : safeJson(value); return tail(raw.trim(), limit); }
function boundedJson(value, limit) { return tail(safeJson(value && typeof value === 'object' ? value : { value: String(value ?? '') }), limit); }
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function tail(value, limit) { if (!value) return ''; return value.length <= limit ? value : `[Earlier output truncated by Cuppet]\n${value.slice(-limit)}`; }
function normalizeName(value) { return String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ -]+/g, '_').toLowerCase(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
