import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { providerFailureError } from '../src/runtime/providers/provider-failure.mjs';

const classify=(message, providerID='grok-build')=>classifyProviderError(new Error(message),{provider:{providerID}});

test('provider errors produce specific user-facing categories',()=>{
  assert.equal(classify('Provider request failed (429): rate limit exceeded').category,'rate_limit');
  assert.equal(classify('401 Unauthorized: token expired').category,'authentication');
  assert.equal(classify('insufficient_quota: no credits remaining').category,'quota_exhausted');
  assert.equal(classify('service unavailable 503').category,'provider_unavailable');
  assert.equal(classify('Internal error','opencode').category,'provider_unavailable');
  assert.equal(classify('fetch failed ECONNRESET').category,'network');
  assert.equal(classify('request timed out').category,'timeout');
  assert.equal(classify('maximum context length exceeded').category,'context_limit');
  assert.equal(classify('model not found').category,'model_unavailable');
  assert.equal(classify('streaming failed: unexpected end of stream').category,'streaming');
});

test('structured process failures do not incorrectly tell users to repair installation',()=>{
  const exited=providerFailureError('OpenCode ACP exited',{code:'PROVIDER_PROCESS_EXITED',category:'process_exited',retryable:true,action:'retry'});
  const value=classifyProviderError(exited,{provider:{providerID:'opencode'}});
  assert.equal(value.category,'streaming');
  assert.equal(value.action,'retry');
  assert.equal(value.title,'Provider process stopped');
  assert.match(value.message,/fresh provider process automatically/);
});

test('structured missing executable failures still require provider repair',()=>{
  const missing=providerFailureError('OpenCode missing',{code:'PROVIDER_EXECUTABLE_MISSING',category:'executable_missing',retryable:false,action:'reconnect_provider'});
  const value=classifyProviderError(missing,{provider:{providerID:'opencode'}});
  assert.equal(value.category,'local_agent_unavailable');
  assert.equal(value.action,'reconnect_provider');
});

test('OpenCode ACP errors remain actionable instead of becoming unknown',()=>{
  const auth=classify('OpenCode: provider authentication required ({"providerId":"anthropic"})','opencode');
  assert.equal(auth.category,'authentication');
  assert.equal(auth.action,'reauthenticate');
  const unavailable=classify('OpenCode: No provider available ({"service":"session"})','opencode');
  assert.equal(unavailable.category,'model_unavailable');
  assert.equal(unavailable.action,'change_model');
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
