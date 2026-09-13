import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { MessageActivity, RuntimeEvent, Session } from '../types';
import {
  hydrateTranscript,
  mergeTranscriptState,
  reduceTranscriptEvent,
  type TranscriptState,
} from './chat-transcript';

const EMPTY_TRANSCRIPT: TranscriptState = Object.freeze({});
const states = new Map<string, TranscriptState>();
const listeners = new Map<string, Set<() => void>>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientTranscript(session: Session | null): TranscriptState {
  const sessionId = session?.id ?? null;
  const activities = session?.activities ?? EMPTY_ACTIVITIES;
  const durable = useMemo(() => hydrateTranscript(activities), [activities]);

  useEffect(() => {
    if (!sessionId) return;
    hydrateClientTranscript(sessionId, activities);
  }, [sessionId, activities]);

  const subscribe = useMemo(() => (listener: () => void) => {
    if (!sessionId) return () => {};
    return subscribeClientTranscript(sessionId, listener);
  }, [sessionId]);
  const getSnapshot = useMemo(() => () => sessionId ? clientTranscriptSnapshot(sessionId) : EMPTY_TRANSCRIPT, [sessionId]);
  const live = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => sessionId ? mergeTranscriptState(live, durable) : EMPTY_TRANSCRIPT, [sessionId, live, durable]);
}

export function hydrateClientTranscript(sessionId: string, activities: MessageActivity[] = []) {
  const id = text(sessionId);
  if (!id) return EMPTY_TRANSCRIPT;
  const durable = hydrateTranscript(activities);
  const current = states.get(id);
  const next = current ? mergeTranscriptState(current, durable) : durable;
  states.set(id, next);
  notify(id);
  return next;
}

export function clientTranscriptSnapshot(sessionId: string): TranscriptState {
  const id = text(sessionId);
  return id ? states.get(id) ?? EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT;
}

export function subscribeClientTranscript(sessionId: string, listener: () => void) {
  const id = text(sessionId);
  if (!id) return () => {};
  let group = listeners.get(id);
  if (!group) {
    group = new Set();
    listeners.set(id, group);
  }
  group.add(listener);
  ensureRuntimeSubscription();
  return () => {
    const current = listeners.get(id);
    current?.delete(listener);
    if (current && !current.size) listeners.delete(id);
    if (!listeners.size) releaseRuntimeSubscription();
  };
}

export function reduceClientTranscriptEvent(event: RuntimeEvent) {
  const type = text(event?.type);
  if (!SUPPORTED_EVENT_TYPES.has(type)) return false;
  const sessionId = text(event?.sessionId ?? event?.message?.sessionId);
  const messageId = text(event?.messageId ?? event?.message?.id);
  if (!sessionId || !messageId) return false;
  const current = states.get(sessionId) ?? EMPTY_TRANSCRIPT;
  const next = reduceTranscriptEvent(current, { ...event, messageId });
  if (next === current) return false;
  states.set(sessionId, next);
  notify(sessionId);
  return true;
}

export function resetClientTranscriptStore() {
  releaseRuntimeSubscription();
  states.clear();
  listeners.clear();
}

function ensureRuntimeSubscription() {
  if (unsubscribeRuntime || typeof window === 'undefined' || !window.cuppet?.onEvent) return;
  unsubscribeRuntime = window.cuppet.onEvent((event) => {
    reduceClientTranscriptEvent(event);
  });
}

function releaseRuntimeSubscription() {
  const unsubscribe = unsubscribeRuntime;
  unsubscribeRuntime = null;
  unsubscribe?.();
}

function notify(sessionId: string) {
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

const EMPTY_ACTIVITIES: MessageActivity[] = Object.freeze([]) as unknown as MessageActivity[];
const SUPPORTED_EVENT_TYPES = new Set(['runtime.activity', 'message.preview', 'message.delta', 'message.completed']);
