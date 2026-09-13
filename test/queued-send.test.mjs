import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsPersistedCredential,
  providerExecutionIdentity,
  queueSafeSendParams,
  rehydrateQueuedSendParams,
} from '../src/runtime/queued-send.mjs';

test('queued send payload strips credentials recursively before persistence', () => {
  const safe = queueSafeSendParams({
    sessionId: 's1',
    text: 'queued work',
    provider: {
      providerID: 'openai',
      apiKey: 'sk-super-secret',
      headers: { Authorization: 'Bearer abc', 'x-client': 'cuppet' },
      nested: { refreshToken: 'refresh-secret', harmless: 'kept' },
      primary: { providerID: 'openai', modelID: 'gpt-test', variant: 'high' },
    },
    metadata: { accessToken: 'outside-provider-secret', harmless: 'yes' },
  });

  assert.equal(containsPersistedCredential(safe), false);
  assert.equal(JSON.stringify(safe).includes('sk-super-secret'), false);
  assert.equal(JSON.stringify(safe).includes('refresh-secret'), false);
  assert.equal(JSON.stringify(safe).includes('outside-provider-secret'), false);
  assert.equal(safe.provider.headers['x-client'], 'cuppet');
  assert.equal(safe.provider.nested.harmless, 'kept');
  assert.equal(safe.metadata.harmless, 'yes');
});

test('queued send rehydrates only from current host provider credentials', () => {
  const queued = queueSafeSendParams({
    sessionId: 's1',
    text: 'queued work',
    provider: provider('old-secret'),
  });
  const current = provider('new-secret');
  const hydrated = rehydrateQueuedSendParams(queued, current);

  assert.equal(hydrated.provider.apiKey, 'new-secret');
  assert.deepEqual(providerExecutionIdentity(hydrated.provider), providerExecutionIdentity(current));
  assert.equal(queued.provider.apiKey, undefined);
});

test('queued send fails closed when provider execution identity changed while waiting', () => {
  const queued = queueSafeSendParams({ sessionId: 's1', text: 'queued work', provider: provider('old-secret') });
  const changed = provider('new-secret');
  changed.primary = { ...changed.primary, modelID: 'different-model' };

  assert.throws(
    () => rehydrateQueuedSendParams(queued, changed),
    /Provider settings changed while it was waiting/i,
  );
});

function provider(apiKey) {
  return {
    providerID: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKey,
    primary: { providerID: 'openai', modelID: 'gpt-test', variant: 'high' },
    secondary: { providerID: 'openai', modelID: 'gpt-small', variant: '' },
  };
}
