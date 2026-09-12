import { createHash, randomUUID } from 'node:crypto';

/**
 * Owns the mapping between a Cuppet conversation and provider logical sessions.
 *
 * Cuppet is the durable context authority. Every provider turn receives the
 * compiled conversation, while provider processes may stay warm as an
 * implementation detail. Bridge state is tracked per runtime fingerprint so a
 * conversation can switch providers and later return to a still-warm runtime
 * without confusing provider-owned history with Cuppet-owned replay context.
 */
export class ConversationBridge {
  #states = new Map();

  beginTurn({ conversationId, runtimeFingerprint, messages = [] } = {}) {
    const id = requiredText(conversationId, 'conversationId');
    const fingerprint = requiredText(runtimeFingerprint, 'runtimeFingerprint');
    let state = this.#states.get(id);
    if (!state) {
      state = {
        routes: new Map(),
        activeToken: null,
        activeRuntimeFingerprint: null,
        lastRuntimeFingerprint: null,
        totalCompletedTurns: 0,
      };
      this.#states.set(id, state);
    }
    if (state.activeToken) throw new Error('This Cuppet conversation already has an active provider bridge turn.');

    let route = state.routes.get(fingerprint);
    if (!route) {
      route = { completedTurns: 0, lastReplayFingerprint: null };
      state.routes.set(fingerprint, route);
    }

    const token = `bridge_${randomUUID()}`;
    const replayMessages = cloneMessages(messages);
    const replayFingerprint = fingerprintMessages(replayMessages);
    state.activeToken = token;
    state.activeRuntimeFingerprint = fingerprint;
    state.lastRuntimeFingerprint = fingerprint;

    return Object.freeze({
      token,
      conversationId: id,
      runtimeFingerprint: fingerprint,
      contextOwner: 'cuppet',
      delivery: 'full-replay',
      providerHistory: 'turn-isolated',
      providerSessionAction: route.completedTurns === 0 ? 'start' : 'new-session',
      replayFingerprint,
      messages: Object.freeze(replayMessages),
    });
  }

  completeTurn(plan) {
    const { state, route } = this.#stateForPlan(plan);
    state.activeToken = null;
    state.activeRuntimeFingerprint = null;
    state.lastRuntimeFingerprint = plan.runtimeFingerprint;
    state.totalCompletedTurns += 1;
    route.completedTurns += 1;
    route.lastReplayFingerprint = plan.replayFingerprint;
    return this.snapshot(plan.conversationId);
  }

  abortTurn(plan) {
    const id = String(plan?.conversationId ?? '');
    const state = this.#states.get(id);
    if (!state || state.activeToken !== plan?.token) return false;
    const fingerprint = String(plan?.runtimeFingerprint ?? state.activeRuntimeFingerprint ?? '');
    state.activeToken = null;
    state.activeRuntimeFingerprint = null;
    if (fingerprint) state.routes.delete(fingerprint);
    if (state.lastRuntimeFingerprint === fingerprint) state.lastRuntimeFingerprint = null;
    if (!state.routes.size) this.#states.delete(id);
    return true;
  }

  forgetRuntime(conversationId, runtimeFingerprint) {
    const id = String(conversationId ?? '');
    const fingerprint = String(runtimeFingerprint ?? '');
    const state = this.#states.get(id);
    if (!state || !fingerprint) return false;
    if (state.activeRuntimeFingerprint === fingerprint) throw new Error('Cannot forget an active provider bridge runtime.');
    const removed = state.routes.delete(fingerprint);
    if (state.lastRuntimeFingerprint === fingerprint) state.lastRuntimeFingerprint = null;
    if (!state.routes.size && !state.activeToken) this.#states.delete(id);
    return removed;
  }

  forget(conversationId) {
    return this.#states.delete(String(conversationId ?? ''));
  }

  clear() {
    this.#states.clear();
  }

  snapshot(conversationId) {
    const state = this.#states.get(String(conversationId ?? ''));
    if (!state) return emptySnapshot();
    const fingerprint = state.activeRuntimeFingerprint || state.lastRuntimeFingerprint || null;
    const route = fingerprint ? state.routes.get(fingerprint) : null;
    return Object.freeze({
      contextOwner: 'cuppet',
      delivery: 'full-replay',
      providerHistory: 'turn-isolated',
      runtimeFingerprint: fingerprint,
      completedTurns: route?.completedTurns ?? 0,
      totalCompletedTurns: state.totalCompletedTurns,
      warmRuntimeCount: state.routes.size,
      active: Boolean(state.activeToken),
      lastReplayFingerprint: route?.lastReplayFingerprint ?? null,
    });
  }

  #stateForPlan(plan) {
    const id = requiredText(plan?.conversationId, 'plan.conversationId');
    const fingerprint = requiredText(plan?.runtimeFingerprint, 'plan.runtimeFingerprint');
    const state = this.#states.get(id);
    if (!state || state.activeToken !== plan?.token || state.activeRuntimeFingerprint !== fingerprint) {
      throw new Error('Conversation bridge turn is no longer active.');
    }
    const route = state.routes.get(fingerprint);
    if (!route) throw new Error('Conversation bridge runtime route is no longer available.');
    return { state, route };
  }
}

export function fingerprintConversationMessages(messages = []) {
  return fingerprintMessages(cloneMessages(messages));
}

function emptySnapshot() {
  return Object.freeze({
    contextOwner: 'cuppet',
    delivery: 'full-replay',
    providerHistory: 'turn-isolated',
    runtimeFingerprint: null,
    completedTurns: 0,
    totalCompletedTurns: 0,
    warmRuntimeCount: 0,
    active: false,
    lastReplayFingerprint: null,
  });
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
