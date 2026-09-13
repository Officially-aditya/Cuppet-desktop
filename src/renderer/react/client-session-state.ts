import { useSyncExternalStore } from 'react';
import type { Message, RuntimeEvent, Session } from '../types';

let sessions: Session[] = frozenSessions([]);
let refreshPromise: Promise<Session[]> | null = null;
const detailRefreshes = new Map<string, Promise<Session>>();
const listeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientSessions(): Session[] {
  return useSyncExternalStore(subscribeClientSessions, clientSessionsSnapshot, clientSessionsSnapshot);
}

export function clientSessionsSnapshot(): Session[] {
  return sessions;
}

export function clientSessionSnapshot(sessionId: string | null | undefined) {
  const id = text(sessionId);
  return id ? sessions.find((session) => session.id === id) ?? null : null;
}

export function hydrateClientSessions(values: Session[] = []) {
  const current = new Map(sessions.map((session) => [session.id, session]));
  const next = sortSessions(values.map((session) => mergeSession(current.get(session.id), session)));
  if (sameSessions(sessions, next)) return sessions;
  sessions = next;
  notify();
  return sessions;
}

export function upsertClientSession(session: Session | null | undefined) {
  if (!session?.id) return sessions;
  const next = [...sessions];
  const index = next.findIndex((item) => item.id === session.id);
  if (index >= 0) next[index] = mergeSession(next[index], session);
  else next.push(normalizeSession(session));
  return replaceSessions(next);
}

export function upsertClientMessage(message: Message | null | undefined) {
  if (!message?.id || !message.sessionId) return false;
  const index = sessions.findIndex((session) => session.id === message.sessionId);
  if (index < 0) return false;
  const session = sessions[index];
  const messages = [...(session.messages ?? [])];
  const messageIndex = messages.findIndex((item) => item.id === message.id);
  if (messageIndex >= 0) messages[messageIndex] = { ...messages[messageIndex], ...message };
  else messages.push(message);
  messages.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const next = [...sessions];
  next[index] = { ...session, messages };
  return replaceSessions(next) !== sessions;
}

export async function refreshClientSessions() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = window.cuppet.sessions.list().then((next) => hydrateClientSessions(next)).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function refreshClientSession(sessionId: string) {
  const id = text(sessionId);
  if (!id) throw new Error('sessionId is required');
  const existing = detailRefreshes.get(id);
  if (existing) return existing;
  const refresh = window.cuppet.sessions.get(id).then((session) => {
    upsertClientSession(session);
    return session;
  }).finally(() => {
    detailRefreshes.delete(id);
  });
  detailRefreshes.set(id, refresh);
  return refresh;
}

export function reduceClientSessionEvent(event: RuntimeEvent) {
  let handled = false;
  const type = String(event?.type ?? '');
  const sessionId = text(event?.sessionId ?? event?.message?.sessionId);

  if (event?.session?.id) {
    upsertClientSession(event.session);
    handled = true;
  }
  if (event?.message?.id && event.message.sessionId) {
    upsertClientMessage(event.message);
    handled = true;
  } else if (type === 'message.delta' && sessionId && event?.messageId) {
    const session = clientSessionSnapshot(sessionId);
    const message = session?.messages?.find((item) => item.id === event.messageId);
    if (message) {
      upsertClientMessage({ ...message, content: String(event.content ?? ''), status: 'streaming' });
      handled = true;
    }
  }
  if ((type === 'message.created' || type === 'message.completed' || type === 'run.finished') && sessionId && !event?.message?.id) {
    void refreshClientSession(sessionId).catch(() => undefined);
    handled = true;
  }
  if (SESSION_COLLECTION_REFRESH_EVENTS.has(type)) {
    void refreshClientSessions().catch(() => undefined);
    handled = true;
  }
  return handled;
}

export function resetClientSessionStateStore() {
  releaseRuntimeSubscription();
  sessions = frozenSessions([]);
  refreshPromise = null;
  detailRefreshes.clear();
  listeners.clear();
}

function subscribeClientSessions(listener: () => void) {
  listeners.add(listener);
  ensureRuntimeSubscription();
  if (!sessions.length) void refreshClientSessions().catch(() => undefined);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) releaseRuntimeSubscription();
  };
}

function ensureRuntimeSubscription() {
  if (unsubscribeRuntime || typeof window === 'undefined' || !window.cuppet?.onEvent) return;
  unsubscribeRuntime = window.cuppet.onEvent((event) => {
    reduceClientSessionEvent(event);
  });
}

function releaseRuntimeSubscription() {
  const unsubscribe = unsubscribeRuntime;
  unsubscribeRuntime = null;
  unsubscribe?.();
}

function replaceSessions(values: Session[]) {
  const next = sortSessions(values);
  if (sameSessions(sessions, next)) return sessions;
  sessions = next;
  notify();
  return sessions;
}

function mergeSession(current: Session | undefined, incoming: Session) {
  const value = incoming as Session & Record<string, unknown>;
  return normalizeSession({
    ...current,
    ...incoming,
    messages: Object.prototype.hasOwnProperty.call(value, 'messages') ? incoming.messages : current?.messages ?? [],
    activities: Object.prototype.hasOwnProperty.call(value, 'activities') ? incoming.activities : current?.activities,
    toolExecutions: Object.prototype.hasOwnProperty.call(value, 'toolExecutions') ? incoming.toolExecutions : current?.toolExecutions,
  });
}

function normalizeSession(session: Session) {
  return { ...session, messages: Array.isArray(session.messages) ? session.messages : [] };
}

function sortSessions(values: readonly Session[]) {
  return frozenSessions([...values].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
}

function frozenSessions(values: Session[]) {
  return Object.freeze(values) as unknown as Session[];
}

function sameSessions(current: readonly Session[], next: readonly Session[]) {
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (current[index] !== next[index]) return false;
  }
  return true;
}

function notify() {
  for (const listener of listeners) listener();
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

const SESSION_COLLECTION_REFRESH_EVENTS = new Set([
  'session.archived',
  'session.deleted',
  'session.restored',
  'session.purged',
]);
