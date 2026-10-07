// Remote history is a view of the desktop session, bounded to fit one relay frame.
const PROJECTION_BUDGET = 256 * 1024;
const MAX_TEXT = 32 * 1024;

export function sessionSummary(session) {
  return {
    id: session.id, projectId: session.projectId ?? null, title: session.title,
    createdAt: session.createdAt, updatedAt: session.updatedAt, lastStatus: session.lastStatus,
  };
}

export function sessionProjection(session, { beforeSequence, limit } = {}) {
  const all = (session.messages ?? []).map((message, index) => ({ ...message, sequence: message.sequence ?? index + 1 })).filter((message) => message.role !== 'system');
  const before = Number.isSafeInteger(beforeSequence) && beforeSequence > 0 ? beforeSequence : Infinity;
  const eligible = all.filter((message) => message.sequence < before);
  const count = Number.isSafeInteger(limit) ? Math.min(80, Math.max(1, limit)) : 40;
  let messages = eligible.slice(-count).map((message) => ({
    id: message.id, sequence: message.sequence, role: message.role, status: message.status,
    content: String(message.content ?? '').slice(0, MAX_TEXT),
    ...(String(message.content ?? '').length > MAX_TEXT ? { truncated: true } : {}),
  }));
  const ids = new Set(messages.map((message) => message.id));
  const tools = new Map();
  const reasoning = new Map();
  let truncated = messages.some((message) => message.truncated);
  for (const entry of session.activities ?? []) {
    if (!ids.has(entry.messageId)) continue;
    const activity = entry.activity ?? {};
    if (activity.type === 'activity.reasoning.delta') {
      const previous = reasoning.get(entry.messageId);
      const text = `${previous?.activity.text ?? ''}${activity.text ?? ''}`;
      if (text.length > MAX_TEXT) truncated = true;
      reasoning.set(entry.messageId, { messageId: entry.messageId, sequence: previous?.sequence ?? entry.sequence,
        activity: { type: activity.type, text: text.slice(0, MAX_TEXT) } });
    } else if (String(activity.type).startsWith('activity.tool.')) {
      const details = String(activity.details ?? activity.message ?? activity.summary ?? '');
      if (details.length > 4096) truncated = true;
      tools.set(`${entry.messageId}:${activity.callId}`, {
        messageId: entry.messageId, sequence: entry.sequence,
        activity: { type: activity.type, callId: activity.callId, tool: activity.tool, label: activity.label,
          status: activity.status, details: details.slice(0, 4096) },
      });
    }
  }
  let activities = [...reasoning.values(), ...tools.values()];
  let toolExecutions = (session.toolExecutions ?? []).filter((item) => !item.messageId || ids.has(item.messageId)).slice(-80)
    .map((item) => ({ callId: item.callId, messageId: item.messageId, tool: item.tool, status: item.status }));
  const result = () => ({ session: { ...sessionSummary(session), messages, activities, toolExecutions },
    history: { hasMore: eligible.length > messages.length, beforeSequence: messages[0]?.sequence ?? null, truncated } });
  while (Buffer.byteLength(JSON.stringify(result()), 'utf8') > PROJECTION_BUDGET) {
    if (messages.length > 1) {
      messages.shift();
      const remaining = new Set(messages.map((message) => message.id));
      activities = activities.filter((item) => remaining.has(item.messageId));
      toolExecutions = toolExecutions.filter((item) => !item.messageId || remaining.has(item.messageId));
    } else if (activities.length) {
      activities.shift(); truncated = true;
    } else if (toolExecutions.length) {
      toolExecutions.shift(); truncated = true;
    } else {
      break;
    }
  }
  return result();
}
