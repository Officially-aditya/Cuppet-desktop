import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../transports/acp/acp-session.mjs';
import { activityToLegacyEvent } from '../runtime-manager-legacy.mjs';

export class AcpProviderAdapter {
  #configuration;
  #descriptor;

  constructor(configuration = {}, { descriptor = null } = {}) {
    this.#configuration = { ...configuration };
    const providerID = text(configuration?.providerID || configuration?.primary?.providerID);
    this.#descriptor = descriptor ?? localCliDescriptor(providerID);
    if (!this.#descriptor || this.#descriptor.transport !== 'acp') {
      throw new Error(`Unsupported ACP backend: ${providerID || 'unknown'}`);
    }
  }

  cuppetManagedRuntime() {
    return {
      protocol: 'acp',
      backendId: this.#descriptor.id,
      descriptor: this.#descriptor,
      configuration: this.#configuration,
    };
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

function text(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
