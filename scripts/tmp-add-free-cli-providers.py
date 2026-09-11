from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor missing in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, count))


Path('src/runtime/local-cli-descriptors.mjs').write_text(r'''const DESCRIPTORS = Object.freeze({
  opencode: descriptor({
    id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_OPENCODE_BIN',
    loginHint: 'Run `opencode auth login` in Terminal and configure the provider you want OpenCode to use.',
  }),
  'grok-build': descriptor({
    id: 'grok-build', label: 'Grok Build', transport: 'acp', command: 'grok', args: ['--no-auto-update', 'agent', 'stdio'], versionArgs: ['version'], envOverride: 'CUPPET_GROK_BIN',
    loginHint: 'Run `grok login` in Terminal once, then retry.',
  }),
  'github-copilot': descriptor({
    id: 'github-copilot', label: 'GitHub Copilot', transport: 'acp', command: 'copilot', args: ['--acp', '--stdio', '--no-auto-update', '--no-remote', '--disable-builtin-mcps'], versionArgs: ['--version'], envOverride: 'CUPPET_COPILOT_BIN',
    loginHint: 'Run `copilot` in Terminal once and complete GitHub sign-in, then retry.',
  }),
  'mistral-vibe': descriptor({
    id: 'mistral-vibe', label: 'Mistral Vibe', transport: 'acp', command: 'vibe-acp', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_VIBE_BIN',
    loginHint: 'Run `vibe --setup` in Terminal once and complete Mistral sign-in/setup, then retry.',
  }),
  kiro: descriptor({
    id: 'kiro', label: 'Kiro', transport: 'acp', command: 'kiro-cli', args: ['acp'], versionArgs: ['--version'], envOverride: 'CUPPET_KIRO_BIN',
    loginHint: 'Run `kiro-cli` in Terminal once and complete sign-in, then retry.',
  }),
  antigravity: descriptor({
    id: 'antigravity', label: 'Google Antigravity', transport: 'headless-plan', command: 'agy', args: [], versionArgs: ['--version'], envOverride: 'CUPPET_ANTIGRAVITY_BIN',
    loginHint: 'Run `agy` in Terminal once and complete Google sign-in, then retry.',
  }),
});

export function localCliDescriptor(value) {
  const item = DESCRIPTORS[String(value ?? '').trim().toLowerCase()];
  return item ? { ...item, args: [...item.args], versionArgs: [...item.versionArgs] } : null;
}

export function isLocalCliProvider(value) { return Boolean(localCliDescriptor(value)); }
export function localCliProviderIDs() { return Object.keys(DESCRIPTORS); }

function descriptor(value) { return Object.freeze({ ...value, args: Object.freeze([...value.args]), versionArgs: Object.freeze([...value.versionArgs]) }); }
''')

acp = Path('src/runtime/acp-cli-provider.mjs').read_text()
acp = acp.replace("import { tmpdir } from 'node:os';\n", "import { tmpdir } from 'node:os';\nimport { localCliDescriptor } from './local-cli-descriptors.mjs';\n", 1)
start = acp.index('const DESCRIPTORS = Object.freeze({')
end = acp.index('export class AcpCliAgentProvider')
acp = acp[:start] + "export function isAcpCliProvider(value) {\n  return localCliDescriptor(value)?.transport === 'acp';\n}\n\nexport function acpCliDescriptor(value) {\n  const descriptor = localCliDescriptor(value);\n  return descriptor?.transport === 'acp' ? descriptor : null;\n}\n\n" + acp[end:]
Path('src/runtime/acp-cli-provider.mjs').write_text(acp)

Path('src/runtime/antigravity-provider.mjs').write_text(r'''import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localCliDescriptor } from './local-cli-descriptors.mjs';

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const PROMPT_TIMEOUT_MS = 30 * 60_000;

export class AntigravityHeadlessProvider {
  #configuration;
  #descriptor;

  constructor(configuration = {}) {
    this.#configuration = configuration;
    this.#descriptor = localCliDescriptor('antigravity');
  }

  async stream(messages, { signal, onDelta = async () => {}, projectRoot = null } = {}) {
    if (signal?.aborted) throw abortError();
    const command = text(this.#configuration.cliCommand) || text(process.env[this.#descriptor.envOverride]) || this.#descriptor.command;
    const prompt = antigravityPrompt(messages);
    const cwd = projectRoot ? resolve(projectRoot) : tmpdir();
    const baseArgs = Array.isArray(this.#configuration.cliArgs) && this.#configuration.cliArgs.length
      ? this.#configuration.cliArgs.map((value) => String(value))
      : [...this.#descriptor.args];
    const args = [...baseArgs, '--mode=plan', '--sandbox', '--output-format', 'stream-json', '--print-timeout', '30m', '-p', prompt];
    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    } catch (error) {
      throw launchError(this.#descriptor, error);
    }

    let output = '';
    let finalResponse = '';
    let usage = null;
    let stderr = '';
    let settled = false;
    let abortListener;
    const lines = createInterface({ input: child.stdout });
    const completion = new Promise((resolveRun, rejectRun) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        rejectRun(new Error('Antigravity headless request timed out.'));
      }, PROMPT_TIMEOUT_MS);
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      child.once('error', (error) => finish(rejectRun, launchError(this.#descriptor, error)));
      child.once('exit', (code, exitSignal) => {
        if (signal?.aborted) { finish(rejectRun, abortError()); return; }
        if (code === 0) finish(resolveRun, undefined);
        else finish(rejectRun, new Error(`Google Antigravity exited${code !== null ? ` with code ${code}` : ''}${exitSignal ? ` (${exitSignal})` : ''}.${stderr.trim() ? ` ${stderr.trim().slice(-1200)}` : ''}`));
      });
    });

    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.event === 'step_update' && event?.step_update?.step_type === 'agent_response') {
        const delta = typeof event.step_update.text_delta === 'string' ? event.step_update.text_delta : '';
        if (delta) { output += delta; void onDelta(delta); }
      }
      if (event?.event === 'result') {
        finalResponse = typeof event.result?.response === 'string' ? event.result.response : finalResponse;
        usage = normalizeUsage(event.result?.usage);
        if (event.result?.status && event.result.status !== 'SUCCESS') stderr = `${stderr}\nAntigravity status: ${event.result.status}`.trim();
      }
    });

    abortListener = () => { try { child.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', abortListener, { once: true });
    try {
      await completion;
      if (signal?.aborted) throw abortError();
      const textOutput = output || finalResponse;
      if (!textOutput.trim()) throw new Error(`Google Antigravity returned no response.${stderr.trim() ? ` ${stderr.trim().slice(-1200)}` : ''}`);
      if (!output && finalResponse) await onDelta(finalResponse);
      return { text: textOutput, toolCalls: [], usage };
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      lines.close();
      try { child.kill(); } catch {}
    }
  }
}

function antigravityPrompt(messages) {
  const safety = [
    '[CUPPET ANTIGRAVITY BRIDGE]',
    'You are running through Google Antigravity headless PLAN mode inside Cuppet.',
    'Direct file writes, shell execution, browser actions, and other mutations are intentionally not delegated through this transport because Cuppet cannot intercept Antigravity headless permission prompts yet.',
    'Use project read access for analysis. Never claim that you edited files, ran commands, tests, or changed the workspace.',
    'For change requests, return a precise implementation plan and exact suggested code/diff where useful so the user can act on it safely.',
    '[/CUPPET ANTIGRAVITY BRIDGE]',
  ].join('\n');
  const conversation = (Array.isArray(messages) ? messages : []).map((message) => {
    const role = String(message?.role ?? 'user').toUpperCase();
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    return `[${role}]\n${content}`;
  }).join('\n\n');
  const value = `${safety}\n\n${conversation}`;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= MAX_PROMPT_BYTES ? value : `${safety}\n\n${bytes.subarray(bytes.length - MAX_PROMPT_BYTES).toString('utf8')}`;
}

function normalizeUsage(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!Object.keys(source).length) return null;
  return {
    inputTokens: number(source.input_tokens ?? source.inputTokens),
    outputTokens: number(source.output_tokens ?? source.outputTokens),
    totalTokens: number(source.total_tokens ?? source.totalTokens),
    cachedInputTokens: number(source.cache_read_tokens ?? source.cached_input_tokens ?? source.cachedInputTokens),
    reasoningTokens: number(source.thinking_tokens ?? source.reasoning_tokens ?? source.reasoningTokens),
  };
}
function launchError(descriptor, error) { return error?.code === 'ENOENT' ? new Error(`${descriptor.label} CLI was not found. ${descriptor.loginHint}`) : error instanceof Error ? error : new Error(String(error)); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
''')

replace(
    'src/runtime/provider-factory.mjs',
    "import { AcpCliAgentProvider, isAcpCliProvider } from './acp-cli-provider.mjs';\n",
    "import { AcpCliAgentProvider, isAcpCliProvider } from './acp-cli-provider.mjs';\nimport { AntigravityHeadlessProvider } from './antigravity-provider.mjs';\n",
)
replace(
    'src/runtime/provider-factory.mjs',
    "  if (providerID === 'codex') return new CodexSubscriptionProvider(configuration);\n  if (isAcpCliProvider(providerID)) return new AcpCliAgentProvider(configuration);",
    "  if (providerID === 'codex') return new CodexSubscriptionProvider(configuration);\n  if (providerID === 'antigravity') return new AntigravityHeadlessProvider(configuration);\n  if (isAcpCliProvider(providerID)) return new AcpCliAgentProvider(configuration);",
)

replace(
    'src/main/cli-agent-status.mjs',
    "import { acpCliDescriptor } from '../runtime/acp-cli-provider.mjs';",
    "import { localCliDescriptor } from '../runtime/local-cli-descriptors.mjs';",
)
replace(
    'src/main/cli-agent-status.mjs',
    "  const descriptor = acpCliDescriptor(providerID);",
    "  const descriptor = localCliDescriptor(providerID);",
)
replace(
    'src/main/cli-agent-status.mjs',
    "  const versionArgs = descriptor.id === 'grok-build' ? ['version'] : ['--version'];",
    "  const versionArgs = descriptor.versionArgs;",
)
replace(
    'src/main/cli-agent-status.mjs',
    "    home ? join(home, '.grok', 'bin') : '',\n    home ? join(home, '.bun', 'bin') : '',",
    "    home ? join(home, '.grok', 'bin') : '',\n    home ? join(home, '.kiro', 'bin') : '',\n    home ? join(home, '.vibe', 'bin') : '',\n    home ? join(home, '.copilot', 'bin') : '',\n    home ? join(home, '.bun', 'bin') : '',",
)

replace(
    'src/main/main.mjs',
    "  if (!['opencode', 'grok-build'].includes(id)) throw new Error('Unsupported local CLI provider.');",
    "  if (!['opencode', 'grok-build', 'github-copilot', 'mistral-vibe', 'kiro', 'antigravity'].includes(id)) throw new Error('Unsupported local CLI provider.');",
)

presets = r'''  antigravity: Object.freeze({
    id: 'antigravity',
    label: 'Google Antigravity',
    baseUrl: 'cli://antigravity',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Antigravity default', description: 'Uses the model selected by your local Antigravity account/configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Antigravity CLI',
    note: 'Uses your locally authenticated Google Antigravity CLI. Cuppet runs the current headless transport in plan + sandbox mode so it cannot bypass Cuppet mutation permissions; this provider is analysis/planning-only until Google exposes an interceptable agent protocol.',
  }),
  'github-copilot': Object.freeze({
    id: 'github-copilot',
    label: 'GitHub Copilot',
    baseUrl: 'cli://github-copilot',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Copilot default', description: 'Uses the default model selected by your GitHub Copilot plan/configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local GitHub Copilot CLI',
    note: 'Uses the official Copilot CLI ACP server over stdio. Authentication and plan usage remain owned by GitHub Copilot; Cuppet does not copy credentials.',
  }),
  'mistral-vibe': Object.freeze({
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    baseUrl: 'cli://mistral-vibe',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Vibe default', description: 'Uses the model/profile selected in your local Vibe configuration.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Mistral Vibe CLI',
    note: 'Uses the official Vibe ACP agent. Mistral credentials and Free/paid plan usage stay in Vibe; Cuppet does not read the stored credential.',
  }),
  kiro: Object.freeze({
    id: 'kiro',
    label: 'Kiro',
    baseUrl: 'cli://kiro',
    model: 'cli-default',
    models: Object.freeze([
      Object.freeze({ id: 'cli-default', label: 'Kiro default', description: 'Uses the active model available to your local Kiro account.' }),
    ]),
    authType: 'local-cli',
    authLabel: 'Local Kiro CLI',
    note: 'Uses the official `kiro-cli acp` interface as an ACP client. Authentication and Kiro plan credits remain inside Kiro.',
  }),
'''
replace(
    'src/main/provider-presets.mjs',
    "  openai: Object.freeze({",
    presets + "  openai: Object.freeze({",
)

# ACP tests: ensure all official ACP transports resolve to their documented commands.
test = Path('test/acp-cli-provider.test.mjs').read_text()
test = test.replace("import { AcpCliAgentProvider } from '../src/runtime/acp-cli-provider.mjs';", "import { AcpCliAgentProvider, acpCliDescriptor } from '../src/runtime/acp-cli-provider.mjs';", 1)
test += r'''

test('local ACP provider descriptors use official stdio entrypoints', () => {
  assert.deepEqual(acpCliDescriptor('github-copilot')?.args.slice(0, 2), ['--acp', '--stdio']);
  assert.equal(acpCliDescriptor('mistral-vibe')?.command, 'vibe-acp');
  assert.deepEqual(acpCliDescriptor('kiro')?.args, ['acp']);
  assert.equal(acpCliDescriptor('antigravity'), null);
});
'''
Path('test/acp-cli-provider.test.mjs').write_text(test)

Path('test/fixtures/fake-antigravity-agent.mjs').write_text(r'''const args = process.argv.slice(2);
const required = ['--mode=plan', '--sandbox', '--output-format', 'stream-json'];
for (const flag of required) {
  if (!args.includes(flag)) {
    process.stderr.write(`missing ${flag}\n`);
    process.exit(2);
  }
}
if (args.includes('--dangerously-skip-permissions')) {
  process.stderr.write('unsafe permission bypass present\n');
  process.exit(3);
}
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'fake-antigravity' }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Plan ' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'ready.' } }) + '\n');
process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Plan ready.', usage: { input_tokens: 11, output_tokens: 3, thinking_tokens: 2, cache_read_tokens: 4, total_tokens: 14 } } }) + '\n');
''')

Path('test/antigravity-provider.test.mjs').write_text(r'''import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AntigravityHeadlessProvider } from '../src/runtime/antigravity-provider.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-antigravity-agent.mjs', import.meta.url));

test('Antigravity provider stays in safe headless plan/sandbox mode', async () => {
  let streamed = '';
  const provider = new AntigravityHeadlessProvider({ providerID: 'antigravity', cliCommand: process.execPath, cliArgs: [fixture] });
  const result = await provider.stream([{ role: 'user', content: 'Inspect this project.' }], {
    projectRoot: tmpdir(),
    onDelta: async (delta) => { streamed += delta; },
  });
  assert.equal(result.text, 'Plan ready.');
  assert.equal(streamed, 'Plan ready.');
  assert.equal(result.usage.totalTokens, 14);
  assert.equal(result.usage.cachedInputTokens, 4);
  assert.equal(result.usage.reasoningTokens, 2);
});
''')
