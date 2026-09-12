import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { normalizeAcpTextDeltas } from '../src/runtime/providers/transports/acp/acp-text-stream.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-tokenized-agent.mjs', import.meta.url));
const expected = 'messy, but I’ll figure it out!\n\n**Inspecting sitemap for clarity**\n\nI feel like I need to provide a direct answer.';
const expectedReasoning = 'how to pull this together effectively!\n\n**Clarifying tracker status**\n\nI need to check.';

test('tokenized ACP framing removes transport blank lines without damaging Markdown blocks', () => {
  const chunks = [
    'messy', '\n\n', ',', '\n\n', 'but', '\n\n', 'I', '\n\n', '’ll', '\n\n', 'figure', '\n\n', 'it', '\n\n', 'out', '\n\n', '!',
    '\n\n', '**Inspecting sitemap for clarity**', '\n\n',
    'I', '\n\n', 'feel', '\n\n', 'like', '\n\n', 'I', '\n\n', 'need', '\n\n', 'to', '\n\n', 'provide', '\n\n', 'a', '\n\n', 'direct', '\n\n', 'answer', '.',
  ];
  assert.equal(normalizeAcpTextDeltas(chunks, { framing: 'tokenized-whitespace' }), expected);
  assert.equal(normalizeAcpTextDeltas(['Hello', '\n\n- one\n- two\n\n', 'Done.']), 'Hello\n\n- one\n- two\n\nDone.');
});

test('production runtime manager reconstructs Copilot tokenized message and reasoning output', async () => {
  const descriptor = localCliDescriptor('github-copilot');
  assert.equal(descriptor.textStream?.framing, 'tokenized-whitespace');
  const adapter = new AcpProviderAdapter({
    providerID: 'github-copilot',
    cliCommand: process.execPath,
    cliArgs: [fixture],
  }, { descriptor });
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {} });
  let streamed = '';
  let activityText = '';
  const reasoning = [];
  try {
    const result = await manager.adapterFor({
      sessionId: 'copilot-tokenized-chat',
      projectRoot: tmpdir(),
      adapter,
    }).stream([{ role: 'user', content: 'Inspect sitemap.' }], {
      onDelta: async (delta) => { streamed += delta; },
      onActivity: async (activity) => {
        if (activity?.type === 'activity.text.delta') activityText += activity.text;
        if (activity?.type === 'activity.reasoning.delta') reasoning.push(activity.text);
      },
    });
    assert.equal(result.text, expected);
    assert.equal(streamed, expected);
    assert.equal(activityText, expected);
    assert.deepEqual(reasoning, [expectedReasoning]);
  } finally {
    await manager.close();
  }
});

test('stateless ACP adapter emits one normalized Copilot reasoning phase', async () => {
  const descriptor = localCliDescriptor('github-copilot');
  const adapter = new AcpProviderAdapter({
    providerID: 'github-copilot',
    cliCommand: process.execPath,
    cliArgs: [fixture],
  }, { descriptor });
  let streamed = '';
  const reasoning = [];
  const result = await adapter.stream([{ role: 'user', content: 'Inspect sitemap.' }], {
    onDelta: async (delta) => { streamed += delta; },
    onProviderEvent: async (event) => {
      if (event?.type === 'reasoning') reasoning.push(event.text);
    },
  });
  assert.equal(result.text, expected);
  assert.equal(streamed, expected);
  assert.deepEqual(reasoning, [expectedReasoning]);
});
