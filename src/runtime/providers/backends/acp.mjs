import { localCliDescriptor } from '../../local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../transports/acp/acp-session.mjs';
import { CuppetMcpToolSession } from '../transports/acp/cuppet-mcp-tool-session.mjs';
import { AcpTextStreamAssembler } from '../transports/acp/acp-text-stream.mjs';
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
    const toolSession = this.#descriptor.mcpToolBridge === true
      ? await maybeToolSession({ backendId: this.#descriptor.id, sessionId: `stateless-${Date.now()}`, options })
      : null;
    const activityState = new Map();
    const textStream = new AcpTextStreamAssembler(this.#descriptor.textStream);
    const activityTextStream = new AcpTextStreamAssembler(this.#descriptor.textStream);
    let reasoningStream = usesTokenizedWhitespace(this.#descriptor.textStream)
      ? new AcpTextStreamAssembler(this.#descriptor.textStream)
      : null;
    const forwardActivity = async (activity) => {
      const legacy = activityToLegacyEvent(activity, activityState);
      if (legacy) await options.onProviderEvent?.(legacy);
    };
    const flushReasoning = async () => {
      if (!reasoningStream) return;
      reasoningStream.flush();
      const reasoning = reasoningStream.text;
      reasoningStream = new AcpTextStreamAssembler(this.#descriptor.textStream);
      if (reasoning) await forwardActivity({ type: 'activity.reasoning.delta', text: reasoning });
    };
    try {
      await runtime.start({ mcpServers: toolSession ? [toolSession.descriptor()] : [] });
      const result = await runtime.runTurn({ messages }, {
        signal: options.signal,
        executeTool: options.executeTool,
        requestAgentPermission: options.requestAgentPermission,
        onText: async (rawDelta) => {
          const delta = textStream.push(rawDelta);
          if (delta) await options.onDelta?.(delta);
        },
        onActivity: async (activity) => {
          if (reasoningStream && activity?.type === 'activity.reasoning.delta') {
            reasoningStream.push(activity.text);
            return;
          }
          await flushReasoning();
          if (activity?.type === 'activity.text.delta') {
            const delta = activityTextStream.push(activity.text);
            if (!delta) return;
            await forwardActivity({ ...activity, text: delta });
            return;
          }
          await forwardActivity(activity);
        },
      });
      await flushReasoning();
      textStream.flush();
      activityTextStream.flush();
      return { ...result, text: textStream.text || result.text };
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
function usesTokenizedWhitespace(value) { return String(value?.framing ?? '').trim().toLowerCase() === 'tokenized-whitespace'; }
function text(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
