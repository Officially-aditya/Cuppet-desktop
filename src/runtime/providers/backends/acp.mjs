import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../transports/acp/acp-session.mjs';
import { CuppetMcpToolSession } from '../transports/acp/cuppet-mcp-tool-session.mjs';
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
    const toolSession = await maybeToolSession({ backendId: this.#descriptor.id, sessionId: `stateless-${Date.now()}`, options });
    const activityState = new Map();
    try {
      await runtime.start({ mcpServers: toolSession ? [toolSession.descriptor()] : [] });
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
      await toolSession?.close().catch(() => undefined);
    }
  }
}

async function maybeToolSession({ backendId, sessionId, options }) {
  if (!Array.isArray(options?.tools) || !options.tools.length || typeof options?.executeTool !== 'function') return null;
  const session = new CuppetMcpToolSession({ backendId, sessionId });
  await session.start();
  session.setTurn({ tools: options.tools, executeTool: options.executeTool, signal: options.signal });
  return session;
}
function text(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
