import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../src/runtime/codex-app-server.mjs';
import { parseCodexAccount } from '../src/runtime/codex-account.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

test('Codex app-server transport initializes and reads official ChatGPT account union', async () => {
  const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] });
  try {
    const requestPromise = once(client, 'request');
    await client.start();
    const account = parseCodexAccount(await client.request('account/read', {}));
    assert.equal(account.loggedIn, true);
    assert.equal(account.type, 'chatgpt');
    assert.equal(account.email, 'fake@example.com');
    assert.equal(account.planType, 'plus');

    const [request] = await requestPromise;
    assert.equal(request.method, 'item/tool/call');
    assert.equal(request.params.tool, 'echo');
    const toolResponse = once(client, 'notification');
    client.respond(request.id, { contentItems: [{ type: 'inputText', text: 'ok' }], success: true });
    const [notification] = await toolResponse;
    assert.equal(notification.method, 'test/tool-response');
    assert.equal(notification.params.success, true);
  } finally {
    await client.close();
  }
});

test('Codex app-server transport exposes ChatGPT login start and completion', async () => {
  const client = new CodexAppServerClient({ command: process.execPath, args: [fixture] });
  try {
    await client.start();
    const completed = once(client, 'notification');
    const result = await client.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' });
    assert.equal(result.type, 'chatgpt');
    assert.equal(result.loginId, 'fake-login');
    assert.match(result.authUrl, /^https:\/\//);
    let notification;
    for (;;) {
      [notification] = await completed;
      if (notification.method === 'account/login/completed') break;
    }
    assert.equal(notification.params.loginId, 'fake-login');
    assert.equal(notification.params.success, true);
  } finally {
    await client.close();
  }
});

test('account parser rejects API-key auth as subscription login', () => {
  const account = parseCodexAccount({ account: { type: 'apiKey' } });
  assert.equal(account.loggedIn, false);
  assert.equal(account.method, 'apiKey');
});
