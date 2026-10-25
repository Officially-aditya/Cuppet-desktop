import { useSyncExternalStore } from 'react';
import type { Attachment, Message, RuntimeEvent, Session } from '../types';
import { applyClientMessageDelta, resetClientTranscriptStore, syncClientTranscriptMessages } from './client-transcript';

export type PendingUserMessage = {
  id: string;
  sessionId: string;
  kind: 'send' | 'steer';
  content: string;
  attachments: Attachment[];
  afterSequence: number;
};
const EMPTY_PENDING: readonly PendingUserMessage[] = [];
const pendingMessages = new Map<string, readonly PendingUserMessage[]>();
const confirmedPendingMessages = new Set<string>();
let nextPendingId = 0;

let sessions: Session[] = frozenSessions([]);
const UNREAD_SESSIONS_KEY = 'cuppet.desktop.unread-sessions';
let unreadSessions: ReadonlySet<string> = loadUnreadSessions();
let viewedSessionId: string | null = null;
let refreshPromise: Promise<Session[]> | null = null;
const detailRefreshes = new Map<string, Promise<Session>>();
const listeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientSessions(): Session[] {
  return useSyncExternalStore(subscribeClientSessions, clientSessionsSnapshot, clientSessionsSnapshot);
}

export function usePendingUserMessages(sessionId: string | null | undefined) {
  const snapshot = () => pendingUserMessagesSnapshot(sessionId);
  return useSyncExternalStore(subscribeClientSessions, snapshot, snapshot);
}

export function pendingUserMessagesSnapshot(sessionId: string | null | undefined) {
  return sessionId ? pendingMessages.get(sessionId) ?? EMPTY_PENDING : EMPTY_PENDING;
}

export function addPendingUserMessage(input: Omit<PendingUserMessage, 'id' | 'afterSequence'>) {
  const id = `pending_${++nextPendingId}`;
  const afterSequence = Math.max(0, ...(clientSessionSnapshot(input.sessionId)?.messages ?? []).map((message) => message.sequence ?? 0));
  pendingMessages.set(input.sessionId, [...pendingUserMessagesSnapshot(input.sessionId), { ...input, id, afterSequence }]);
  notify();
  return id;
}

export function removePendingUserMessage(id: string) {
  for (const [sessionId, items] of pendingMessages) {
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) continue;
    if (next.length) pendingMessages.set(sessionId, next);
    else pendingMessages.delete(sessionId);
    notify();
    return;
  }
}

function reconcilePendingMessages(session: Session) {
  for (const message of session.messages ?? []) {
    if (message.role !== 'user' || confirmedPendingMessages.has(message.id)) continue;
    const pending = pendingUserMessagesSnapshot(session.id).find((item) =>
      (message.sequence == null || message.sequence > item.afterSequence) && item.content === message.content &&
      item.attachments.length === (message.attachments?.length ?? 0) &&
      item.attachments.every((attachment, index) => attachment.name === message.attachments?.[index]?.name &&
        (attachment.dataUrl === message.attachments?.[index]?.dataUrl || (Boolean(attachment.dataUrl) && message.attachments?.[index]?.hasData))
        && attachment.path === message.attachments?.[index]?.path));
    if (pending) {
      confirmedPendingMessages.add(message.id);
      removePendingUserMessage(pending.id);
    }
  }
}

export function clientSessionsSnapshot(): Session[] {
  return sessions;
}

export function useClientUnreadSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeClientSessions, clientUnreadSessionsSnapshot, clientUnreadSessionsSnapshot);
}

export function clientUnreadSessionsSnapshot(): ReadonlySet<string> {
  return unreadSessions;
}

export function setViewedClientSession(sessionId: string | null) {
  viewedSessionId = text(sessionId) || null;
  if (viewedSessionId) setSessionUnread(viewedSessionId, false);
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
  for (const session of next) {
    syncClientTranscriptMessages(session.id, session.messages);
    reconcilePendingMessages(session);
  }
  notify();
  return sessions;
}

export function upsertClientSession(session: Session | null | undefined) {
  if (!session?.id) return sessions;
  const next = [...sessions];
  const index = next.findIndex((item) => item.id === session.id);
  if (index >= 0) next[index] = mergeSession(next[index], session);
  else next.push(normalizeSession(session));
  const result = replaceSessions(next);
  const merged = clientSessionSnapshot(session.id);
  if (merged) syncClientTranscriptMessages(session.id, merged.messages);
  reconcilePendingMessages(session);
  return result;
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
  const previous = sessions;
  replaceSessions(next);
  syncClientTranscriptMessages(session.id, [messages.find((item) => item.id === message.id)!]);
  reconcilePendingMessages({ ...session, messages: [message] });
  return sessions !== previous;
}

export async function refreshClientSessions() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = window.cuppet.sessions.list().then((next) => hydrateClientSessions(next)).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function refreshClientSession(sessionId: string, options: { limit?: number; beforeSequence?: number } = {}) {
  const id = text(sessionId);
  if (!id) throw new Error('sessionId is required');
  const key = options.beforeSequence === undefined ? id : `${id}:${options.beforeSequence}`;
  const existing = detailRefreshes.get(key);
  if (existing) return existing;
  const limit = options.limit ?? Math.min(10_000, Math.max(60, (clientSessionSnapshot(id)?.messages.length ?? 0) + 20));
  const refresh = window.cuppet.sessions.get(id, { ...options, limit }).then((session) => {
    upsertClientSession(session);
    return session;
  }).finally(() => {
    detailRefreshes.delete(key);
  });
  detailRefreshes.set(key, refresh);
  return refresh;
}

export function reduceClientSessionEvent(event: RuntimeEvent) {
  let handled = false;
  const type = String(event?.type ?? '');
  const sessionId = text(event?.sessionId ?? event?.message?.sessionId);

  if ((type === 'run.finished' || type === 'session.purged') && pendingMessages.delete(sessionId)) notify();
  if (type === 'run.started' && event.sourceSessionId && event.sourceSessionId !== sessionId) {
    for (const item of pendingUserMessagesSnapshot(String(event.sourceSessionId))) {
      if (item.kind === 'send') removePendingUserMessage(item.id);
    }
  }

  if (type === 'message.completed' && event?.message?.role === 'assistant' && sessionId && sessionId !== viewedSessionId) {
    setSessionUnread(sessionId, true);
  }
  if (type === 'session.purged' && sessionId) setSessionUnread(sessionId, false);

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
    if (message && message.status === 'streaming' && typeof event.delta === 'string' && Number.isSafeInteger(event.seq)) {
      if (!applyClientMessageDelta(message, event)) void refreshClientSession(sessionId).catch(() => undefined);
      handled = true;
    } else if (!message) {
      void refreshClientSession(sessionId).catch(() => undefined);
    }
  }
  if (SESSION_DETAIL_REFRESH_EVENTS.has(type) && sessionId && !event?.message?.id) {
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
  unreadSessions = loadUnreadSessions();
  viewedSessionId = null;
  refreshPromise = null;
  detailRefreshes.clear();
  pendingMessages.clear();
  confirmedPendingMessages.clear();
  listeners.clear();
  resetClientTranscriptStore();
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
  const incomingIsOlder = Boolean(
    current &&
    typeof current.updatedAt === 'number' &&
    typeof incoming.updatedAt === 'number' &&
    incoming.updatedAt < current.updatedAt
  );
  const base = incomingIsOlder
    ? { ...incoming, ...current }
    : { ...current, ...incoming };
  return normalizeSession({
    ...base,
    messages: Object.prototype.hasOwnProperty.call(value, 'messages') ? mergeMessages(current?.messages, incoming.messages, Boolean(incoming.history)) : current?.messages ?? [],
    activities: mergeByKey(current?.activities, incoming.activities, row => `${row.messageId}:${row.sequence}`),
    toolExecutions: mergeByKey(current?.toolExecutions, incoming.toolExecutions, row => row.id),
    history: incoming.history && (!current?.history || (incoming.history.beforeSequence ?? Infinity) <= (current.history.beforeSequence ?? Infinity))
      ? incoming.history : current?.history,
  });
}

function mergeByKey<T>(current: T[] | undefined, incoming: T[] | undefined, key: (row: T) => string): T[] | undefined {
  if (!incoming?.length) return current ?? incoming;
  if (!current?.length) return incoming;
  const rows = new Map(current.map(row => [key(row), row]));
  for (const row of incoming) rows.set(key(row), row);
  return [...rows.values()];
}

const TERMINAL_MESSAGE_STATUSES = new Set(['complete', 'error', 'stopped']);

// A refreshed session is a point-in-time read that can arrive after newer events. Merge it by id
// instead of replacing the list so it can never drop a message created after the read (a sent or
// steered prompt) or roll a message back to an earlier streaming state. Unchanged messages keep
// their identity so memoized transcript rows are not re-rendered by every refresh.
function mergeMessages(current: Message[] | undefined, incoming: Message[] | undefined, windowed = false): Message[] {
  if (!Array.isArray(incoming)) return current ?? [];
  if (!current?.length) return incoming;
  const known = new Map(current.map((message) => [message.id, message]));
  const incomingIds = new Set<string>();
  let incomingLatest = 0;
  let incomingFirst = Infinity;
  const merged = incoming.map((message) => {
    incomingIds.add(message.id);
    incomingLatest = Math.max(incomingLatest, message.sequence ?? 0);
    incomingFirst = Math.min(incomingFirst, message.sequence ?? 0);
    const previous = known.get(message.id);
    return previous ? reconcileMessage(previous, message) : message;
  });
  for (const message of current) {
    // Created after the snapshot was read, so the snapshot cannot know about it.
    if (!incomingIds.has(message.id) && ((message.sequence ?? 0) > incomingLatest || (windowed && (message.sequence ?? 0) < incomingFirst))) merged.push(message);
  }
  merged.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return merged.length === current.length && merged.every((message, index) => message === current[index]) ? current : merged;
}

function reconcileMessage(current: Message, incoming: Message): Message {
  const currentDone = TERMINAL_MESSAGE_STATUSES.has(current.status ?? '');
  const incomingDone = TERMINAL_MESSAGE_STATUSES.has(incoming.status ?? '');
  if (currentDone && !incomingDone) return current;
  if (!currentDone && !incomingDone && (current.content ?? '').length > (incoming.content ?? '').length) return current;
  if (sameMessage(current, incoming)) return current;
  return { ...current, ...incoming };
}

function sameMessage(a: Message, b: Message) {
  return a.status === b.status && a.content === b.content && a.sequence === b.sequence
    && a.updatedAt === b.updatedAt && sameAttachments(a.attachments, b.attachments);
}

function sameAttachments(a: Attachment[] | undefined, b: Attachment[] | undefined) {
  if (a === b) return true;
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  // Attachments are immutable once sent, so cheap metadata is enough (avoids comparing multi-MB data URLs).
  return (a ?? []).every((item, index) => {
    const other = (b ?? [])[index];
    return item.name === other.name && item.path === other.path && item.mime === other.mime
      && item.size === other.size && item.hasData === other.hasData && item.dataUrl?.length === other.dataUrl?.length;
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

function loadUnreadSessions(): ReadonlySet<string> {
  try {
    const values = JSON.parse(localStorage.getItem(UNREAD_SESSIONS_KEY) ?? '[]');
    return new Set(Array.isArray(values) ? values.filter((id) => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function setSessionUnread(sessionId: string, unread: boolean) {
  if (unreadSessions.has(sessionId) === unread) return;
  const next = new Set(unreadSessions);
  if (unread) next.add(sessionId);
  else next.delete(sessionId);
  unreadSessions = next;
  try { localStorage.setItem(UNREAD_SESSIONS_KEY, JSON.stringify([...next])); } catch {}
  notify();
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

const SESSION_DETAIL_REFRESH_EVENTS = new Set([
  'message.created',
  'message.completed',
  'run.finished',
]);

const SESSION_COLLECTION_REFRESH_EVENTS = new Set([
  'session.archived',
  'session.deleted',
  'session.restored',
  'session.purged',
]);
