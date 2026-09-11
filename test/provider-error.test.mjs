import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';

const classify=(message, providerID='grok-build')=>classifyProviderError(new Error(message),{provider:{providerID}});

test('provider errors produce specific user-facing categories',()=>{
  assert.equal(classify('Provider request failed (429): rate limit exceeded').category,'rate_limit');
  assert.equal(classify('401 Unauthorized: token expired').category,'authentication');
  assert.equal(classify('insufficient_quota: no credits remaining').category,'quota_exhausted');
  assert.equal(classify('service unavailable 503').category,'provider_unavailable');
  assert.equal(classify('fetch failed ECONNRESET').category,'network');
  assert.equal(classify('request timed out').category,'timeout');
  assert.equal(classify('maximum context length exceeded').category,'context_limit');
  assert.equal(classify('model not found').category,'model_unavailable');
  assert.equal(classify('streaming failed: unexpected end of stream').category,'streaming');
});

test('account provider auth errors tell user to reconnect',()=>{
  const value=classify('login expired','github-copilot');
  assert.equal(value.title,'Sign-in required');
  assert.match(value.message,/Reconnect GitHub Copilot in Settings → Platform/);
  assert.equal(value.action,'reauthenticate');
});

test('API auth errors tell user to update credentials',()=>{
  const value=classifyProviderError(new Error('401 invalid api key'),{provider:{providerID:'openai'}});
  assert.match(value.message,/Update the API key/);
});
