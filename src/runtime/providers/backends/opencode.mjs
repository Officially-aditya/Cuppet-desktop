import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../transports/acp/acp-session.mjs';
import { activityToLegacyEvent } from '../runtime-manager-legacy.mjs';

export class OpenCodeAcpProviderV2 {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = configuration;
    this.#descriptor = localCliDescriptor('opencode');
  }

  cuppetManagedRuntime() {
    return { backendId: 'opencode', configuration: this.#configuration };
  }

  async stream(messages, options = {}) {
    const runtime = new AcpSessionRuntime({
      descriptor: this.#descriptor,
      configuration: this.#configuration,
      projectRoot: options.projectRoot ?? null,
    });
    const activityState = new Map();
    try {
      await runtime.start();
      return await runtime.runTurn({ messages }, {
        signal: options.signal,
        executeTool: options.executeTool,
        requestAgentPermission: options.requestAgentPermission,
        onText: options.onDelta,
        onActivity: async (activity) => {
          const legacy = activityToLegacyEvent(activity, activityState);
          if (legacy) await options.onProviderEvent?.(legacy);
        },
      });
    } finally {
      await runtime.close();
    }
  }
}
