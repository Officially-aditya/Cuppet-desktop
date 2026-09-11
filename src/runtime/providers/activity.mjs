const ACTIVITY_TYPES = new Set([
  'activity.text.delta',
  'activity.reasoning.delta',
  'activity.tool.opened',
  'activity.tool.updated',
  'activity.tool.closed',
  'activity.plan.updated',
  'activity.permission.requested',
  'activity.permission.resolved',
  'activity.usage',
  'activity.status',
  'activity.warning',
  'activity.error',
]);

export function isProviderActivity(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && ACTIVITY_TYPES.has(value.type));
}

export function providerActivity(type, fields = {}) {
  if (!ACTIVITY_TYPES.has(type)) throw new TypeError(`Unknown provider activity type: ${String(type)}`);
  const source = record(fields);
  const activity = { type, ...source };

  if (type === 'activity.text.delta' || type === 'activity.reasoning.delta') {
    activity.text = requiredDelta(source.text, 'activity text');
  }

  if (type.startsWith('activity.tool.')) {
    activity.callId = requiredText(source.callId, 'tool call id');
    activity.tool = text(source.tool) || 'agent-tool';
    if (source.label !== undefined) activity.label = text(source.label) || activity.tool;
  }

  if (type === 'activity.tool.closed') {
    const status = text(source.status);
    if (!['success', 'error', 'cancelled'].includes(status)) {
      throw new TypeError(`Invalid tool completion status: ${status || '<empty>'}`);
    }
    activity.status = status;
  }

  return Object.freeze(activity);
}

export function activityFromLegacyProviderEvent(event) {
  const source = record(event);
  const type = text(source.type);

  if (type === 'reasoning') {
    const value = typeof source.text === 'string' ? source.text : '';
    return value ? providerActivity('activity.reasoning.delta', { text: value }) : null;
  }

  if (type === 'tool.started') {
    return providerActivity('activity.tool.opened', {
      callId: source.callId,
      tool: source.tool,
      label: source.label,
      argumentsJson: text(source.argumentsJson),
      details: text(source.details),
    });
  }

  if (type === 'tool.finished') {
    return providerActivity('activity.tool.closed', {
      callId: source.callId,
      tool: source.tool,
      label: source.label,
      argumentsJson: text(source.argumentsJson),
      details: text(source.details),
      status: source.success === false ? 'error' : 'success',
    });
  }

  return null;
}

function requiredDelta(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required.`);
  return value;
}

function requiredText(value, label) {
  const result = text(value);
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
