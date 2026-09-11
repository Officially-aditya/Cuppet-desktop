export function activityToLegacyEvent(activity, state = new Map()) {
  if (!activity || typeof activity !== 'object') return null;
  if (activity.type === 'activity.reasoning.delta') return { type: 'reasoning', text: activity.text };
  if (activity.type === 'activity.tool.opened' || activity.type === 'activity.tool.updated') {
    state.set(activity.callId, activity);
    return {
      type: 'tool.started',
      callId: activity.callId,
      tool: activity.tool,
      label: activity.label,
      argumentsJson: activity.argumentsJson ?? '',
      ...(activity.details ? { message: activity.details } : {}),
    };
  }
  if (activity.type === 'activity.tool.closed') {
    const prior = state.get(activity.callId);
    state.delete(activity.callId);
    return {
      type: 'tool.finished',
      callId: activity.callId,
      tool: activity.tool || prior?.tool,
      label: activity.label || prior?.label,
      argumentsJson: activity.argumentsJson || prior?.argumentsJson || '',
      success: activity.status === 'success',
      ...(activity.details ? { message: activity.details } : {}),
    };
  }
  return null;
}
