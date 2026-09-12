import type { MessageActivity, RuntimeEvent } from '../types';

const MAX_ITEMS_PER_MESSAGE = 120;

export type TranscriptReasoning = {
  id: string;
  type: 'reasoning';
  text: string;
  sequence: number;
  endSequence?: number;
};

export type TranscriptTool = {
  id: string;
  type: 'tool';
  status: 'running' | 'complete' | 'error';
  tool: string;
  argumentsJson: string;
  details?: string;
  sequence: number;
};

export type TranscriptItem = TranscriptReasoning | TranscriptTool;
export type TranscriptMessageState = { items: TranscriptItem[]; preview: string };
export type TranscriptState = Record<string, TranscriptMessageState>;

export function hydrateTranscript(rows: MessageActivity[] = []): TranscriptState {
  let state: TranscriptState = {};
  for (const row of rows.slice().sort(compareActivityRows)) {
    state = reduceTranscriptEvent(state, {
      type: 'runtime.activity',
      messageId: row.messageId,
      source: row.source,
      sequence: row.sequence,
      createdAt: row.createdAt,
      activity: row.activity,
    });
  }
  return state;
}

export function reduceTranscriptEvent(state: TranscriptState, event: RuntimeEvent): TranscriptState {
  if (!event || typeof event !== 'object') return state;
  const messageId = text(event.messageId);
  if (!messageId) return state;

  if (event.type === 'message.preview') {
    const content = typeof event.content === 'string' ? event.content : '';
    return updateMessageState(state, messageId, (current) => {
      if (current.preview === content) return current;
      return { ...current, preview: content };
    });
  }

  if (event.type === 'message.delta' || event.type === 'message.completed') {
    return updateMessageState(state, messageId, (current) => current.preview ? { ...current, preview: '' } : current);
  }

  if (event.type !== 'runtime.activity') return state;
  const activity = record(event.activity);
  const activityType = text(activity.type);
  if (!activityType) return state;
  const sequence = finiteSequence(event.sequence);

  if (event.source === 'provider' && activityType === 'activity.reasoning.delta') {
    const segment = typeof activity.text === 'string' ? activity.text.trim() : '';
    if (!segment) return state;
    return updateMessageState(state, messageId, (current) => {
      const items = appendReasoning(current.items, segment, sequence);
      return items === current.items ? current : { ...current, items };
    });
  }

  if (event.source === 'execution' && activityType.startsWith('activity.tool.')) {
    return updateMessageState(state, messageId, (current) => ({
      ...current,
      items: updateTool(current.items, activity, sequence),
    }));
  }

  return state;
}

export function orderedTranscriptItems(items: TranscriptItem[] = []) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareSequence(a.item.sequence, b.item.sequence) || a.index - b.index)
    .map(({ item }) => item);
}

function appendReasoning(items: TranscriptItem[], segment: string, sequence: number | null): TranscriptItem[] {
  const ordered = orderedTranscriptItems(items);
  const last = ordered.at(-1);
  if (last?.type === 'reasoning' && reasoningCanMerge(last, sequence)) {
    const textValue = mergeReasoningText(last.text, segment);
    if (textValue === last.text) return items;
    return boundItems(items.map((item) => item.id === last.id ? {
      ...item,
      text: textValue,
      endSequence: sequence ?? item.endSequence ?? item.sequence,
    } : item));
  }
  const resolvedSequence = sequence ?? nextSequence(items);
  return boundItems([
    ...items,
    {
      id: `reason-${resolvedSequence}-${items.length}`,
      type: 'reasoning',
      text: segment,
      sequence: resolvedSequence,
      endSequence: resolvedSequence,
    },
  ]);
}

function reasoningCanMerge(last: TranscriptReasoning, sequence: number | null) {
  if (sequence === null) return true;
  const end = finiteSequence(last.endSequence) ?? finiteSequence(last.sequence);
  return end === null || sequence >= end;
}

function updateTool(items: TranscriptItem[], activity: Record<string, any>, sequence: number | null): TranscriptItem[] {
  const id = text(activity.executionId) || text(activity.callId) || `tool-${sequence ?? nextSequence(items)}`;
  const existingIndex = items.findIndex((item) => item.type === 'tool' && item.id === id);
  const existing = existingIndex >= 0 ? items[existingIndex] as TranscriptTool : null;
  const tool = text(activity.tool) || existing?.tool || 'agent-tool';
  const argumentsJson = typeof activity.argumentsJson === 'string' ? activity.argumentsJson : existing?.argumentsJson ?? '{}';
  const closed = activity.type === 'activity.tool.closed';
  const status: TranscriptTool['status'] = closed ? (activity.status === 'success' ? 'complete' : 'error') : 'running';
  const patch: TranscriptTool = {
    id,
    type: 'tool',
    status,
    tool,
    argumentsJson,
    sequence: existing?.sequence ?? sequence ?? nextSequence(items),
    ...(typeof activity.details === 'string' && activity.details ? { details: activity.details } : existing?.details ? { details: existing.details } : {}),
  };
  if (existingIndex < 0) return boundItems([...items, patch]);
  const next = [...items];
  next[existingIndex] = patch;
  return boundItems(next);
}

function updateMessageState(state: TranscriptState, messageId: string, updater: (value: TranscriptMessageState) => TranscriptMessageState) {
  const current = state[messageId] ?? { items: [], preview: '' };
  const next = updater(current);
  if (next === current) return state;
  return { ...state, [messageId]: next };
}

function boundItems(items: TranscriptItem[]) {
  if (items.length <= MAX_ITEMS_PER_MESSAGE) return items;
  return orderedTranscriptItems(items).slice(-MAX_ITEMS_PER_MESSAGE);
}

function mergeReasoningText(previous: string, incoming: string) {
  const before = previous.trim();
  const next = incoming.trim();
  if (!before) return next;
  if (!next || next === before || before.endsWith(next)) return before;
  if (next.startsWith(before)) return next;
  const separator = /\s$/.test(previous) || /^\s/.test(incoming) || /^[,.;:!?)}\]]/.test(next) ? '' : ' ';
  return `${previous}${separator}${incoming}`;
}

function nextSequence(items: TranscriptItem[]) {
  let max = -1;
  for (let index = 0; index < items.length; index += 1) {
    const sequence = finiteSequence(items[index]?.sequence);
    max = Math.max(max, sequence ?? index);
  }
  return max + 1;
}

function compareActivityRows(left: MessageActivity, right: MessageActivity) {
  const messageCompare = text(left.messageId).localeCompare(text(right.messageId));
  if (messageCompare) return messageCompare;
  const sequenceCompare = compareSequence(left.sequence, right.sequence);
  if (sequenceCompare) return sequenceCompare;
  return Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0);
}

function compareSequence(left: unknown, right: unknown) {
  const a = finiteSequence(left);
  const b = finiteSequence(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function finiteSequence(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
