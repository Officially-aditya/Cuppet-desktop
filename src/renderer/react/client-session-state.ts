import { useSyncExternalStore } from 'react';
import type { RuntimeEvent, Session } from '../types';

let sessions: Session[] = frozenSessions([]);
let refreshPromise: Promise<Session[]> | null = null;
const listeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientSessions(): Session[] {
  return useSyncExternalStore(subscribeClientSessions, clientSessionsSnapshot, clientSessionsSnapshot);
}

export function clientSessionsSnapshot(): Session[] {
  return sessions;
}

export function hydrateClientSessions(values: Session[] = []) {
  const next = sortSessions(values);
  if (sameSessions(sessions, next)) return sessions;
  sessions = next;
  notify();
  return sessions;
}

export function upsertClientSession(session: Session | null | undefined) {
  if (!session?.id) return sessions;
  const next = [...sessions];
  const index = next.findIndex((item) => item.id === session.id);
  if (index >= 0) next[index] = { ...next[index], ...session };
  else next.push(session);
  return hydrateClientSessions(next);
}

export async function refreshClientSessions() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = window.cuppet.sessions.list().then((next) => hydrateClientSessions(next)).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function reduceClientSessionEvent(event: RuntimeEvent) {
  if (event?.session?.id) {
    upsertClientSession(event.session);
    return true;
  }
  if (SESSION_COLLECTION_REFRESH_EVENTS.has(String(event?.type ?? ''))) {
    void refreshClientSessions().catch(() => undefined);
    return true;
  }
  return false;
}

export function resetClientSessionStateStore() {
  releaseRuntimeSubscription();
  sessions = frozenSessions([]);
  refreshPromise = null;
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

const SESSION_COLLECTION_REFRESH_EVENTS = new Set([
  'session.archived',
  'session.deleted',
  'session.restored',
  'session.purged',
]);
