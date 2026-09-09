import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'package.json',
  'migration/d3-contract.json',
  'docs/d3-native-providers.md',
  'src/runtime/provider.mjs',
  'src/runtime/provider-policy.mjs',
  'src/runtime/provider-factory.mjs',
  'src/runtime/native-provider.mjs',
  'src/runtime/service.mjs',
  'src/runtime/background-enricher.mjs',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const pkg = JSON.parse(text['package.json']);
expect(pkg.scripts?.['d3:verify'] === 'node scripts/verify-d3.mjs', 'D3 verifier script is not registered');

const contract = JSON.parse(text['migration/d3-contract.json']);
expect(contract.phase === 'D3' && contract.status === 'implemented-candidate', 'D3 machine contract identity invalid');
for (const [key, value] of Object.entries(contract.requirements ?? {})) expect(value === true, `D3 contract requirement missing: ${key}`);

const factory = text['src/runtime/provider-factory.mjs'];
expect(factory.includes('createNativeProvider') && factory.includes('new OpenAICompatibleChatProvider'), 'shared provider factory must preserve native routing and generic fallback');
expect(factory.includes("providerRequest(configuration, 'primary').providerID"), 'native routing must use resolved model provider authority');
expect(factory.includes("kind === 'vertex-gemini'") && factory.includes("'x-goog-api-key': key") && factory.includes("searchParams.delete('key')"), 'Vertex API key must be removed from request URLs');
expect(factory.includes("kind === 'gemini-interactions'") && factory.includes('result: { content: item.result }'), 'Gemini function_result lowering must match current Interactions REST shape');

const native = text['src/runtime/native-provider.mjs'];
for (const className of ['OpenAIResponsesProvider','AnthropicMessagesProvider','GeminiInteractionsProvider','VertexGeminiProvider']) expect(native.includes(`class ${className}`), `native adapter missing: ${className}`);
expect(native.includes("case 'openai': return new OpenAIResponsesProvider") && native.includes("case 'anthropic': return new AnthropicMessagesProvider") && native.includes("case 'google': return new GeminiInteractionsProvider") && native.includes("case 'google-vertex': return new VertexGeminiProvider"), 'reviewed native provider mapping changed');
expect(native.includes("`${this.#config.baseUrl}/responses`") && native.includes("`${this.#config.baseUrl}/messages`") && native.includes("`${this.#config.baseUrl}/interactions`"), 'native OpenAI/Anthropic/Gemini endpoints are missing');
expect(native.includes(':streamGenerateContent') && native.includes('publishers/google/models/'), 'Vertex streamGenerateContent lowering is missing');
expect(native.includes("type === 'response.output_text.delta'") && native.includes("type === 'input_json_delta'") && native.includes("type === 'interaction.created'"), 'native streaming parsers are incomplete');

const service = text['src/runtime/service.mjs'];
expect(service.includes("import { createChatProvider } from './provider-factory.mjs'"), 'RuntimeService does not import shared native provider factory');
expect(service.includes('providerFactory = createChatProvider'), 'RuntimeService default provider factory is not native-aware');
expect(service.includes('new BackgroundEnricher({ providerFactory: this.#providerFactory'), 'background role does not share foreground provider factory');

const background = text['src/runtime/background-enricher.mjs'];
expect(background.includes("providerRequest(this.#providerConfig ?? {}, 'secondary')") && background.includes('this.#providerFactory(request)'), 'background secondary provider authority changed');

for (const script of [
  'src/runtime/provider.mjs',
  'src/runtime/provider-factory.mjs',
  'src/runtime/native-provider.mjs',
  'src/runtime/service.mjs',
]) {
  const checked = spawnSync(process.execPath, ['--check', script], { cwd: root, stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
}

const tests = [
  'test/d3-native-provider.test.mjs',
  'test/provider.test.mjs',
  'test/d-provider-policy.test.mjs',
  'test/background-enricher.test.mjs',
];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);

console.log('D3 gate passed: reviewed native OpenAI/Anthropic/Gemini/Vertex execution, tool continuations, host-local credentials, shared foreground/background routing, and OpenAI-compatible fallback verified.');
