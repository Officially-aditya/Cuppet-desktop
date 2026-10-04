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

test('queued images survive serialization and dispatch without truncation', () => {
  const dataUrl = 'data:image/png;base64,' + 'AQID'.repeat(75_000);
  const safe = queueSafeSendParams({
    sessionId: 's1', text: 'inspect this screenshot', provider: provider('old-secret'),
    attachments: [{ name: 'screenshot.png', mime: 'image/png', dataUrl, apiKey: 'attachment-secret' }],
  });
  const hydrated = rehydrateQueuedSendParams(JSON.parse(JSON.stringify(safe)), provider('new-secret'));
  assert.equal(hydrated.attachments[0].dataUrl, dataUrl);
  assert.equal(containsPersistedCredential(safe), false);
  assert.equal(safe.attachments[0].apiKey, undefined);
});

test('queued images still reject invalid and oversized image data', () => {
  const safe = queueSafeSendParams({
    attachments: [
      { name: 'invalid.png', dataUrl: 'javascript:alert(1)' },
      { name: 'huge.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(20 * 1024 * 1024) },
    ],
  });
  assert.equal(safe.attachments.length, 2);
  assert.equal(safe.attachments[0].dataUrl, undefined);
  assert.equal(safe.attachments[1].dataUrl, undefined);
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
