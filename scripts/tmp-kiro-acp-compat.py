from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor missing in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, count))


replace(
    'src/runtime/acp-cli-provider.mjs',
    "      const prompt = await rpc.request('session/prompt', {\n        sessionId,\n        prompt: [{ type: 'text', text: serializeConversation(messages) }],\n      }, PROMPT_TIMEOUT_MS);",
    "      const prompt = await rpc.request('session/prompt', sessionPromptParams(this.#descriptor, sessionId, serializeConversation(messages)), PROMPT_TIMEOUT_MS);",
)
replace(
    'src/runtime/acp-cli-provider.mjs',
    "    if (message?.method === 'session/update') {\n      void this.#handleUpdate(message.params?.update);\n      return;\n    }",
    "    if (message?.method === 'session/update' || message?.method === 'session/notification') {\n      void this.#handleUpdate(message.params?.update ?? message.params);\n      return;\n    }",
)
replace(
    'src/runtime/acp-cli-provider.mjs',
    "    if (source.sessionUpdate === 'agent_message_chunk') {\n      const delta = typeof source.content?.text === 'string' ? source.content.text : '';\n      if (!delta) return;\n      this.#text += delta;\n      await this.#onDelta(delta);\n    }",
    "    if (normalizeUpdateKind(source.sessionUpdate ?? source.type ?? source.kind) === 'agent_message_chunk') {\n      const delta = contentText(source.content);\n      if (!delta) return;\n      this.#text += delta;\n      await this.#onDelta(delta);\n    }",
)
replace(
    'src/runtime/acp-cli-provider.mjs',
    "async function authenticateIfNeeded(rpc, descriptor, initialized) {",
    "function sessionPromptParams(descriptor, sessionId, textValue) {\n  const content = [{ type: 'text', text: textValue }];\n  return descriptor?.id === 'kiro' ? { sessionId, content } : { sessionId, prompt: content };\n}\nfunction normalizeUpdateKind(value) {\n  return String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ -]+/g, '_').toLowerCase();\n}\nfunction contentText(value) {\n  if (typeof value === 'string') return value;\n  if (Array.isArray(value)) return value.map(contentText).join('');\n  return typeof value?.text === 'string' ? value.text : '';\n}\n\nasync function authenticateIfNeeded(rpc, descriptor, initialized) {",
)

Path('test/fixtures/fake-kiro-acp-agent.mjs').write_text(r'''import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kiro-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    if (!Array.isArray(message.params?.content) || message.params.prompt) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'expected Kiro content field' } });
      return;
    }
    write({ jsonrpc: '2.0', method: 'session/notification', params: { sessionId: 'kiro-session', update: { sessionUpdate: 'AgentMessageChunk', content: { type: 'text', text: 'Kiro ready.' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
''')

test = Path('test/acp-cli-provider.test.mjs').read_text()
if 'fake-kiro-acp-agent.mjs' not in test:
    test += r'''

test('Kiro ACP compatibility accepts content prompts and session/notification updates', async () => {
  const kiroFixture = fileURLToPath(new URL('./fixtures/fake-kiro-acp-agent.mjs', import.meta.url));
  const provider = new AcpCliAgentProvider({ providerID: 'kiro', cliCommand: process.execPath, cliArgs: [kiroFixture] });
  let streamed = '';
  const result = await provider.stream([{ role: 'user', content: 'Hello Kiro' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
    executeTool: async () => ({ success: false, output: 'unexpected tool call', paths: [], mutation: false }),
  });
  assert.equal(result.text, 'Kiro ready.');
  assert.equal(streamed, 'Kiro ready.');
});
'''
Path('test/acp-cli-provider.test.mjs').write_text(test)
