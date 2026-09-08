import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const required = [
  'src/runtime/provider-catalog.mjs','src/runtime/provider-variants.mjs','src/runtime/provider-policy.mjs','src/runtime/provider.mjs','src/runtime/background-enricher.mjs','src/runtime/remote/commands.mjs','src/runtime/main.mjs','src/main/provider-settings.mjs','src/main/main.mjs','src/renderer/index.html','src/renderer/app.js','src/remote-app/index.html','src/remote-app/app.js','src/cli/main.mjs','migration/phase-d-contract.json','docs/phase-d-provider-model-effort.md',
];
const text = Object.fromEntries(await Promise.all(required.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
const dense = Object.fromEntries(Object.entries(text).map(([path, value]) => [path, value.replace(/\s+/g, '')]));
const expect = (condition, message) => { if (!condition) throw new Error(message); };

const catalog = text['src/runtime/provider-catalog.mjs'];
expect(catalog.includes('buildProviderCatalog') && catalog.includes('modelSupportsCodingAgent') && catalog.includes('resolveLiveModelRef'), 'provider catalog/resolution surface missing');
expect(catalog.includes("integrationIds: Object.freeze(['openai', 'azure', 'azure-openai'])") && catalog.includes("integrationIds: Object.freeze(['google-vertex', 'google-vertex-anthropic', 'vertex'])"), 'provider alias groups changed');
expect(catalog.includes("input.includes('text')") && catalog.includes("output.includes('text')") && catalog.includes('capabilities.tools === true') && catalog.includes('capabilities.streaming !== false'), 'coding capability contract incomplete');
expect(!catalog.includes('nvidia:'), 'provider catalog became a closed registry');

const variants = text['src/runtime/provider-variants.mjs'];
expect(variants.includes('buildVariantBridge') && variants.includes('effortOptions') && variants.includes('variantRequest'), 'variant bridge/effort surface missing');
expect(variants.includes('sanitizeVariantOptions') && variants.includes("'apikey'") && variants.includes("'authorization'") && variants.includes("'clientsecret'"), 'variant credential sanitizer incomplete');
expect(variants.includes('if (live.length) return unique(live)') && variants.includes('existing.has(id)'), 'live-variant precedence changed');

const policy = text['src/runtime/provider-policy.mjs']; const policyDense = dense['src/runtime/provider-policy.mjs'];
for (const name of ['normalizeProviderConfiguration','providerProjection','resolveAdvertisedSelection','providerRequest','serializableProviderConfiguration']) expect(policy.includes(`function ${name}`) || policy.includes(`export function ${name}`), `provider policy missing: ${name}`);
expect(policyDense.includes("role==='secondary'?config.secondary:config.primary") || policyDense.includes("roleOrSelection==='secondary'?config.secondary:config.primary"), 'primary/secondary role resolution missing');
expect(policy.includes('requestHeaders') && policy.includes('requestBody') && policy.includes('variantRequest'), 'effort does not lower to request metadata');
expect(!/prompt/i.test(policy.split('providerRequest')[1]?.split('serializableProviderConfiguration')[0] ?? ''), 'provider effort policy appears to inject prompt text');

const provider = text['src/runtime/provider.mjs'];
expect(provider.includes('requestHeaders') && provider.includes('requestBody') && provider.includes("authorization: `Bearer ${this.#apiKey}`"), 'provider request metadata/auth precedence missing');
expect(provider.includes('model: this.#model') && provider.includes('messages') && provider.includes('stream: true'), 'runtime-owned provider request fields missing');

const background = text['src/runtime/background-enricher.mjs'];
expect(background.includes("providerRequest(this.#providerConfig ?? {}, 'secondary')"), 'background does not use secondary model role');

const settings = text['src/main/provider-settings.mjs'];
expect(settings.includes('safeStorage.encryptString') && settings.includes('safeStorage.decryptString'), 'local provider secret encryption missing');
expect(settings.includes('primaryEffort') && settings.includes('secondaryEffort') && settings.includes('resolveAdvertisedSelection'), 'persisted role/effort selection missing');
expect(settings.includes('embedded credentials'), 'provider endpoint credential guard missing');

const desktopHtml = text['src/renderer/index.html']; const desktop = text['src/renderer/app.js'];
for (const id of ['provider-id','provider-model','provider-primary-effort','provider-background-model','provider-secondary-effort']) expect(desktopHtml.includes(`id="${id}"`), `desktop D control missing: ${id}`);
expect(desktop.includes('primaryEffort') && desktop.includes('secondaryEffort') && desktop.includes('state.provider.primary?.variant'), 'desktop effort projection incomplete');
expect(desktop.includes('apiKeyConfigured') && !desktop.includes('state.provider.apiKey)'), 'renderer provider secret boundary changed');

const remote = text['src/runtime/remote/commands.mjs']; const remoteApp = text['src/remote-app/app.js']; const remoteHtml = text['src/remote-app/index.html'];
expect(remote.includes('resolveAdvertisedSelection') && remote.includes('providerRequest(this.#provider,selected)'), 'Remote host-advertised selection/request lowering missing');
expect(remote.includes('selectedVariant') && remote.includes('variants:[...model.variants]'), 'Remote model/effort projection missing');
expect(!/params\.(?:apiKey|baseUrl|requestBody|requestHeaders)/.test(remote), 'Remote command payload can supply provider execution metadata');
expect(remoteHtml.includes('id="effort"') && remoteApp.includes("command('model.select',payload)") && remoteApp.includes('model?.variants'), 'Remote browser effort control missing');

const cli = text['src/cli/main.mjs'];
expect(cli.includes("command==='models'") && cli.includes('providerProjection(providerFromEnv(flags))'), 'headless normalized catalog command missing');
for (const env of ['CUPPET_PROVIDER_ID','CUPPET_MODEL','CUPPET_BACKGROUND_MODEL','CUPPET_EFFORT','CUPPET_BACKGROUND_EFFORT','CUPPET_MODEL_CATALOG_JSON','CUPPET_VARIANT_BRIDGE_JSON']) expect(cli.includes(env), `headless D input missing: ${env}`);

const contract = JSON.parse(text['migration/phase-d-contract.json']);
expect(contract.phase === 'D' && contract.requirements?.primarySecondaryIndependent === true && contract.requirements?.effortIsRequestMetadata === true && contract.requirements?.remoteCanProvideEndpoint === false && contract.requirements?.remoteCanProvideApiKey === false && contract.requirements?.remoteCanProvideArbitraryRequestBody === false, 'D machine contract invalid');
expect(contract.security?.rendererReceivesDecryptedApiKey === false && contract.security?.remoteReceivesProviderEndpoint === false && contract.security?.variantBridgeMayContainCredentialFields === false, 'D security contract invalid');

const tests = ['test/d-provider-catalog.test.mjs','test/d-provider-variants.test.mjs','test/d-provider-policy.test.mjs','test/provider.test.mjs','test/background-enricher.test.mjs','test/d-remote-model-policy.test.mjs','test/c2-remote-commands.test.mjs'];
const testRun = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (testRun.status !== 0) process.exit(testRun.status ?? 1);
console.log('Phase D gate passed: dynamic provider catalog, coding capability filtering, independent model roles, sanitized effort variants, request lowering, background secondary role, and desktop/headless/Remote projections verified.');
