from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor missing in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, count))

# Add a bounded, tool-free title generator that uses the configured secondary role.
Path('src/runtime/title-generator.mjs').write_text(r'''import { isAcpCliProvider } from './acp-cli-provider.mjs';
import { providerRequest } from './provider-policy.mjs';

const TITLE_TIMEOUT_MS = 15_000;
const ACCOUNT_PROVIDERS = new Set(['codex', 'antigravity']);

export async function generateChatTitle({ providerFactory, providerConfig, userText, timeoutMs = TITLE_TIMEOUT_MS }) {
  if (typeof providerFactory !== 'function') return null;
  const text = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2400);
  if (!text) return null;
  const configuration = secondaryProviderConfiguration(providerConfig);
  if (!configuration) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || TITLE_TIMEOUT_MS));
  timer.unref?.();
  let output = '';
  try {
    const provider = providerFactory(configuration);
    await provider.stream([
      {
        role: 'system',
        content: 'Create a concise chat title from the user request. Return only the title: 2-6 words, plain text, no quotes, no markdown, no trailing punctuation. Do not use tools.',
      },
      { role: 'user', content: text },
    ], {
      signal: controller.signal,
      tools: [],
      onDelta: async (delta) => { output += String(delta ?? ''); },
    });
    if (controller.signal.aborted) return null;
    return sanitizeChatTitle(output);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function secondaryProviderConfiguration(configuration = {}) {
  const source = record(configuration);
  const secondary = record(source.secondary);
  const providerID = text(secondary.providerID) || text(source.providerID) || text(source.primary?.providerID);
  if (!providerID) return null;

  if (ACCOUNT_PROVIDERS.has(providerID.toLowerCase()) || isAcpCliProvider(providerID)) {
    const modelID = text(secondary.modelID) || text(source.backgroundModel) || text(source.model) || text(source.primary?.modelID);
    return {
      ...source,
      providerID,
      ...(modelID ? { model: modelID, modelID } : {}),
      primary: modelID ? { providerID, modelID, ...(text(secondary.variant) ? { variant: text(secondary.variant) } : {}) } : source.primary,
      primaryEffort: text(secondary.variant) || text(source.secondaryEffort) || text(source.primaryEffort),
    };
  }

  try { return providerRequest(source, 'secondary'); }
  catch { return null; }
}

export function sanitizeChatTitle(value) {
  let title = String(value ?? '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split(/\r?\n/, 1)[0]
    .replace(/^\s*(?:title|chat title)\s*:\s*/i, '')
    .replace(/^["'`*_#\-\s]+|["'`*_#\-\s]+$/g, '')
    .replace(/[.!?;:,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  if (title.length > 64) {
    title = title.slice(0, 64).replace(/\s+\S*$/, '').trim() || title.slice(0, 64).trim();
  }
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 10) return null;
  return title;
}

function text(value) { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
''')

replace(
    'src/runtime/service.mjs',
    "import { classifyProviderError } from './provider-error.mjs';",
    "import { classifyProviderError } from './provider-error.mjs';\nimport { generateChatTitle } from './title-generator.mjs';",
)

replace(
    'src/runtime/service.mjs',
    "    this.#emit({ type: 'message.created', message: delivery.user });\n    this.#emit({ type: 'message.created', message: delivery.assistant });\n\n    const controller = new AbortController();",
    "    this.#emit({ type: 'message.created', message: delivery.user });\n    this.#emit({ type: 'message.created', message: delivery.assistant });\n\n    if (delivery.provisionalTitle) {\n      void this.#generateFirstTurnTitle({ sessionId: targetSessionId, userText: text, provider: params.provider ?? {}, provisionalTitle: delivery.provisionalTitle });\n    }\n\n    const controller = new AbortController();",
)

replace(
    'src/runtime/service.mjs',
    "    if (tx.action === 'create') createdSession = this.#db.createSession({ id: tx.targetSessionId, projectId, title: titleFromMessage(text) });",
    "    const provisionalTitle = titleFromMessage(text);\n    if (tx.action === 'create') createdSession = this.#db.createSession({ id: tx.targetSessionId, projectId, title: provisionalTitle });",
)

replace(
    'src/runtime/service.mjs',
    "    if (!createdSession && targetBefore?.title === 'New chat') this.#db.renameSession(tx.targetSessionId, titleFromMessage(text));",
    "    const needsGeneratedTitle = Boolean(createdSession || targetBefore?.title === 'New chat');\n    if (!createdSession && targetBefore?.title === 'New chat') this.#db.renameSession(tx.targetSessionId, provisionalTitle);",
)

replace(
    'src/runtime/service.mjs',
    "    return { user, assistant, createdSession, sourceSession, targetSession: this.#db.getSessionSummary(tx.targetSessionId) };",
    "    return { user, assistant, createdSession, sourceSession, targetSession: this.#db.getSessionSummary(tx.targetSessionId), provisionalTitle: needsGeneratedTitle ? provisionalTitle : null };",
)

replace(
    'src/runtime/service.mjs',
    "    if (before?.title === 'New chat') this.#db.renameSession(sessionId, titleFromMessage(text));\n    const assistant = this.#db.appendMessage({ id: ids.assistant, sessionId, role: 'assistant', content: '', status: 'streaming' });\n    return { user, assistant, createdSession: null, sourceSession: null, targetSession: this.#db.getSessionSummary(sessionId) };",
    "    const provisionalTitle = before?.title === 'New chat' ? titleFromMessage(text) : null;\n    if (provisionalTitle) this.#db.renameSession(sessionId, provisionalTitle);\n    const assistant = this.#db.appendMessage({ id: ids.assistant, sessionId, role: 'assistant', content: '', status: 'streaming' });\n    return { user, assistant, createdSession: null, sourceSession: null, targetSession: this.#db.getSessionSummary(sessionId), provisionalTitle };",
)

replace(
    'src/runtime/service.mjs',
    "  stop(sessionId) {\n    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');",
    "  async #generateFirstTurnTitle({ sessionId, userText, provider, provisionalTitle }) {\n    try {\n      const title = await generateChatTitle({ providerFactory: this.#providerFactory, providerConfig: provider, userText });\n      if (!title || title === provisionalTitle || this.#closed) return;\n      const current = this.#db.getSessionSummary(sessionId);\n      if (!current || current.title !== provisionalTitle) return;\n      const session = this.#db.renameSession(sessionId, title);\n      this.#emit({ type: 'session.updated', session });\n    } catch {\n      // Chat titles are best-effort metadata; never disturb the foreground response.\n    }\n  }\n\n  stop(sessionId) {\n    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');",
)

Path('test/title-generator.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import test from 'node:test';
import { generateChatTitle, sanitizeChatTitle, secondaryProviderConfiguration } from '../src/runtime/title-generator.mjs';

test('chat title query uses the configured secondary API model', async () => {
  let seenConfig = null;
  let seenMessages = null;
  const providerConfig = {
    providerID: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    models: [
      { providerID: 'openai', modelID: 'primary', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] } },
      { providerID: 'openai', modelID: 'secondary', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] } },
    ],
    primary: { providerID: 'openai', modelID: 'primary' },
    secondary: { providerID: 'openai', modelID: 'secondary' },
  };
  const title = await generateChatTitle({
    providerConfig,
    userText: 'Please fix the composer height after pasting several lines',
    providerFactory(config) {
      seenConfig = config;
      return { async stream(messages, options) { seenMessages = messages; await options.onDelta('Fix Composer Height'); return { text: 'Fix Composer Height' }; } };
    },
  });
  assert.equal(seenConfig.model, 'secondary');
  assert.equal(title, 'Fix Composer Height');
  assert.match(seenMessages[0].content, /2-6 words/);
});

test('account-backed providers project the secondary selection into the title request', () => {
  const result = secondaryProviderConfiguration({
    providerID: 'codex',
    primary: { providerID: 'codex', modelID: 'primary-model' },
    secondary: { providerID: 'codex', modelID: 'secondary-model', variant: 'low' },
  });
  assert.equal(result.providerID, 'codex');
  assert.equal(result.model, 'secondary-model');
  assert.equal(result.primary.modelID, 'secondary-model');
  assert.equal(result.primaryEffort, 'low');
});

test('title sanitizer removes model formatting and bounds noisy output', () => {
  assert.equal(sanitizeChatTitle('**Title: Browser Control Integration.**'), 'Browser Control Integration');
  assert.equal(sanitizeChatTitle('```text\nProvider Error Handling\n```'), 'Provider Error Handling');
  assert.equal(sanitizeChatTitle(''), null);
});
''')

# Renderer verifier also guards the runtime contract because session.updated is what refreshes sidebar titles.
verify = Path('scripts/verify-renderer.mjs').read_text()
anchor = "assert.match(app, /event\\.type === 'pe3\\.routed'/, 'React event path does not follow PE3 routing');"
if anchor not in verify:
    raise SystemExit('verify-renderer anchor missing')
verify = verify.replace(anchor, anchor + "\nconst runtimeService = await read('src/runtime/service.mjs');\nassert.match(runtimeService, /generateChatTitle/, 'first-turn secondary-model title generation missing');\nassert.match(runtimeService, /current\\.title !== provisionalTitle/, 'async title generation can overwrite manual chat renames');", 1)
Path('scripts/verify-renderer.mjs').write_text(verify)
