import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVariantBridge, effortOptions, sanitizeVariantOptions, selectEffort, variantRequest } from '../src/runtime/provider-variants.mjs';

function openAIModel({ variants = [], body = { reasoning: { mode: 'pro' } } } = {}) {
  return {
    id: 'gpt-test-pro', modelID: 'gpt-test-pro', providerID: 'openai',
    api: { id: 'gpt-test', type: 'aisdk', package: '@ai-sdk/openai' },
    request: { headers: {}, body }, variants,
  };
}
function provider(variants) {
  return {
    id: 'openai',
    models: {
      'gpt-test-pro': { variants },
    },
  };
}

test('variant bridge restores OpenAI effort metadata without retaining credentials or losing base reasoning mode', () => {
  const model = openAIModel();
  const bridge = buildVariantBridge([model], [provider({
    high: {
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
      apiKey: 'must-not-survive',
      nested: { authorization: 'Bearer secret', safe: true },
    },
  })]);
  assert.deepEqual(bridge, {
    schema: 1,
    models: [{
      providerID: 'openai', modelID: 'gpt-test-pro',
      variants: [{
        id: 'high', headers: {}, body: {
          reasoning: { mode: 'pro', effort: 'high', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          nested: { safe: true },
        },
      }],
    }],
  });
  assert.doesNotMatch(JSON.stringify(bridge), /must-not-survive|Bearer secret|apiKey|authorization/);
  assert.deepEqual(effortOptions(model, bridge), ['high']);
  assert.deepEqual(selectEffort({ providerID: 'openai', modelID: 'gpt-test-pro' }, 'HIGH', model, bridge), {
    providerID: 'openai', modelID: 'gpt-test-pro', variant: 'high',
  });
  assert.deepEqual(variantRequest(model, 'high', bridge)?.body.reasoning, { mode: 'pro', effort: 'high', summary: 'auto' });
});

test('live variants win over bridge fallback and remain sanitized', () => {
  const model = openAIModel({ variants: [{ id: 'low', headers: { authorization: 'secret' }, body: { reasoning: { effort: 'low' }, api_key: 'secret' } }] });
  const bridge = buildVariantBridge([model], [provider({ low: { reasoningEffort: 'high' }, high: { reasoningEffort: 'high' } })]);
  assert.deepEqual(bridge.models[0].variants.map((variant) => variant.id), ['high']);
  assert.deepEqual(effortOptions(model, bridge), ['low']);
  assert.deepEqual(variantRequest(model, 'low', bridge), { id: 'low', headers: {}, body: { reasoning: { effort: 'low' } } });
});

test('invalid effort reports the live options without inventing a fallback', () => {
  const model = openAIModel({ variants: [{ id: 'low', body: {} }, { id: 'high', body: {} }] });
  assert.throws(() => selectEffort({ providerID: 'openai', modelID: 'gpt-test-pro' }, 'extreme', model), /Available: low, high/);
});

test('secret sanitizer recursively strips common credential keys while retaining safe variant data', () => {
  assert.deepEqual(sanitizeVariantOptions({
    apiKey: 'a', client_secret: 'b', headers: { authorization: 'c' },
    safe: { thinkingConfig: { thinkingBudget: 1024 }, items: [{ password: 'x', value: 1 }] },
  }), {
    safe: { thinkingConfig: { thinkingBudget: 1024 }, items: [{ value: 1 }] },
  });
});
