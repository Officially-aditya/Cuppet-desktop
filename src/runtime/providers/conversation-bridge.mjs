import { createHash, randomUUID } from 'node:crypto';

/**
 * Owns the mapping between a Cuppet conversation and provider logical sessions.
 *
 * V2 intentionally starts with replay-isolated semantics: Cuppet is the durable
 * context authority, every provider turn receives the compiled conversation,
 * and every turn after the first opens a fresh provider logical session. This
 * makes provider process reuse an implementation detail rather than implicit
 * provider-owned conversation history.
 *
 * Persistent provider continuation/resume must be introduced as a separate
 * strategy only after parity tests prove that Cuppet does not duplicate context.
 */
export class ConversationBridge {
  #states = new Map();

  beginTurn({ conversationId, runtimeFingerprint, messages = [] } = {}) {
    const id = requiredText(conversationId, 'conversationId');
    const fingerprint = requiredText(runtimeFingerprint, 'runtimeFingerprint');
    let state = this.#states.get(id);
    if (state && state.runtimeFingerprint !== fingerprint) {
      this.#states.delete(id);
      state = null;
    }
    if (!state) {
      state = {
        runtimeFingerprint: fingerprint,
        completedTurns: 0,
        activeToken: null,
        lastReplayFingerprint: null,
      };
      this.#states.set(id, state);
    }
    if (state.activeToken) throw new Error('This Cuppet conversation already has an active provider bridge turn.');

    const token = `bridge_${randomUUID()}`;
    const replayMessages = cloneMessages(messages);
    const replayFingerprint = fingerprintMessages(replayMessages);
    state.activeToken = token;

    return Object.freeze({
      token,
      conversationId: id,
      contextOwner: 'cuppet',
      delivery: 'full-replay',
      providerHistory: 'turn-isolated',
      providerSessionAction: state.completedTurns === 0 ? 'start' : 'new-session',
      replayFingerprint,
      messages: Object.freeze(replayMessages),
    });
  }

  completeTurn(plan) {
    const state = this.#stateForPlan(plan);
    state.activeToken = null;
    state.completedTurns += 1;
    state.lastReplayFingerprint = plan.replayFingerprint;
    return this.snapshot(plan.conversationId);
  }

  abortTurn(plan) {
    const state = this.#states.get(String(plan?.conversationId ?? ''));
    if (!state || state.activeToken !== plan?.token) return false;
    // A failed/cancelled provider turn has ambiguous provider-side state. Forget
    // the bridge mapping so the next attempt starts from Cuppet's durable replay.
    this.#states.delete(plan.conversationId);
    return true;
  }

  forget(conversationId) {
    return this.#states.delete(String(conversationId ?? ''));
  }

  clear() {
    this.#states.clear();
  }

  snapshot(conversationId) {
    const state = this.#states.get(String(conversationId ?? ''));
    return Object.freeze(state ? {
      contextOwner: 'cuppet',
      delivery: 'full-replay',
      providerHistory: 'turn-isolated',
      runtimeFingerprint: state.runtimeFingerprint,
      completedTurns: state.completedTurns,
      active: Boolean(state.activeToken),
      lastReplayFingerprint: state.lastReplayFingerprint,
    } : {
      contextOwner: 'cuppet',
      delivery: 'full-replay',
      providerHistory: 'turn-isolated',
      runtimeFingerprint: null,
      completedTurns: 0,
      active: false,
      lastReplayFingerprint: null,
    });
  }

  #stateForPlan(plan) {
    const id = requiredText(plan?.conversationId, 'plan.conversationId');
    const state = this.#states.get(id);
    if (!state || state.activeToken !== plan?.token) throw new Error('Conversation bridge turn is no longer active.');
    return state;
  }
}

export function fingerprintConversationMessages(messages = []) {
  return fingerprintMessages(cloneMessages(messages));
}

function cloneMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => Object.freeze({
    role: String(message?.role ?? 'user'),
    content: typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''),
  }));
}

function fingerprintMessages(messages) {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(String(message.role));
    hash.update('\0');
    hash.update(String(message.content));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function requiredText(value, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}
