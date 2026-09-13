import { useSyncExternalStore } from 'react';
import type { RuntimeEvent, Session } from '../types';

export type ClientRunState = ReadonlySet<string>;

let running: ClientRunState = new Set<string>();
const listeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientRunState(): ClientRunState {
  return useSyncExternalStore(subscribeClientRunState, clientRunStateSnapshot, clientRunStateSnapshot);
}

export function clientRunStateSnapshot(): ClientRunState {
  return running;
}

export function isClientSessionRunning(sessionId: string | null | undefined) {
  const id = text(sessionId);
  return Boolean(id && running.has(id));
}

export function hydrateClientRunState(sessions: Session[] = []) {
  const next = new Set<string>();
  for (const session of sessions) {
    if (sessionRunning(session)) next.add(session.id);
  }
  replace(next);
  return running;
}

export function hydrateClientRunSession(session: Session | null | undefined) {
  if (!session?.id) return running;
  return setRunning(session.id, sessionRunning(session));
}

export function markClientRunStarted(sessionId: string | null | undefined) {
  const id = text(sessionId);
  return id ? setRunning(id, true) : running;
}

export function reduceClientRunEvent(event: RuntimeEvent) {
  const type = text(event?.type);
  if (type === 'run.started') {
    const sessionId = text(event?.sessionId ?? event?.message?.sessionId);
    if (!sessionId) return false;
    return changed(setRunning(sessionId, true));
  }
  if (type === 'run.finished') {
    const sessionId = text(event?.sessionId ?? event?.message?.sessionId);
    if (!sessionId) return false;
    return changed(setRunning(sessionId, false));
  }
  if (type === 'pe3.routed') {
    const source = text(event?.sourceSessionId);
    const target = text(event?.targetSessionId);
    if (!source && !target) return false;
    const next = new Set(running);
    if (source) next.delete(source);
    if (target) next.add(target);
    return replace(next);
  }
  return false;
}

export function resetClientRunStateStore() {
  releaseRuntimeSubscription();
  running = new Set<string>();
  listeners.clear();
}

function subscribeClientRunState(listener: () => void) {
  listeners.add(listener);
  ensureRuntimeSubscription();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) releaseRuntimeSubscription();
  };
}

function ensureRuntimeSubscription() {
  if (unsubscribeRuntime || typeof window === 'undefined' || !window.cuppet?.onEvent) return;
  unsubscribeRuntime = window.cuppet.onEvent((event) => {
    reduceClientRunEvent(event);
  });
}

function releaseRuntimeSubscription() {
  const unsubscribe = unsubscribeRuntime;
  unsubscribeRuntime = null;
  unsubscribe?.();
}

function sessionRunning(session: Session) {
  return session.lastStatus === 'streaming' || (session.messages ?? []).some((message) => message.status === 'streaming');
}

function setRunning(sessionId: string, active: boolean): ClientRunState {
  const has = running.has(sessionId);
  if (has === active) return running;
  const next = new Set(running);
  if (active) next.add(sessionId);
  else next.delete(sessionId);
  replace(next);
  return running;
}

function replace(next: Set<string>) {
  if (sameMembers(running, next)) return false;
  running = next;
  for (const listener of listeners) listener();
  return true;
}

function sameMembers(current: ClientRunState, next: Set<string>) {
  if (current.size !== next.size) return false;
  for (const value of current) if (!next.has(value)) return false;
  return true;
}

function changed(value: ClientRunState) {
  return value === running;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}
