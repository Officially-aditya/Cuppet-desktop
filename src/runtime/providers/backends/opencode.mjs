import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../transports/acp/acp-session.mjs';

export class OpenCodeAcpProviderV2 {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = configuration;
    this.#descriptor = localCliDescriptor('opencode');
  }

  async stream(messages, options = {}) {
    const runtime = new AcpSessionRuntime({
      descriptor: this.#descriptor,
      configuration: this.#configuration,
      projectRoot: options.projectRoot ?? null,
      executeTool: options.executeTool,
      requestAgentPermission: options.requestAgentPermission,
    });
    const activityState = new Map();
    try {
      await runtime.start();
      return await runtime.runTurn({ messages }, {
        signal: options.signal,
        onText: options.onDelta,
        onActivity: async (activity) => {
          const legacy = legacyEvent(activity, activityState);
          if (legacy) await options.onProviderEvent?.(legacy);
        },
      });
    } finally {
      await runtime.close();
    }
  }
}

function legacyEvent(activity, state) {
  if (!activity) return null;
  if (activity.type === 'activity.reasoning.delta') return { type: 'reasoning', text: activity.text };
  if (activity.type === 'activity.tool.opened' || activity.type === 'activity.tool.updated') {
    state.set(activity.callId, activity);
    return { type: 'tool.started', callId: activity.callId, tool: activity.tool, label: activity.label, argumentsJson: activity.argumentsJson ?? '', ...(activity.details ? { message: activity.details } : {}) };
  }
  if (activity.type === 'activity.tool.closed') {
    const prior = state.get(activity.callId);
    state.delete(activity.callId);
    return { type: 'tool.finished', callId: activity.callId, tool: activity.tool || prior?.tool, label: activity.label || prior?.label, argumentsJson: activity.argumentsJson || prior?.argumentsJson || '', success: activity.status === 'success', ...(activity.details ? { message: activity.details } : {}) };
  }
  return null;
}
