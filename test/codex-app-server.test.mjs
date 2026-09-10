import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, resolveCodexAppServerCommand } from '../src/runtime/codex-app-server.mjs';
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

test('packaged Codex resolver requires and uses the canonical code-mode host package', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'cuppet-codex-package-'));
  const bin = join(resources, 'codex', 'darwin-arm64', 'bin');
  const appServer = join(bin, 'codex-app-server');
  const codeModeHost = join(bin, 'codex-code-mode-host');
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(appServer, '#!/bin/sh\nexit 0\n');
    await writeFile(codeModeHost, '#!/bin/sh\nexit 0\n');
    await chmod(appServer, 0o755);
    await chmod(codeModeHost, 0o755);

    const resolved = await resolveCodexAppServerCommand({ resourcesPath: resources, env: {}, platform: 'darwin', arch: 'arm64' });
    assert.deepEqual(resolved, { command: appServer, args: [], source: 'packaged' });
  } finally {
    await rm(resources, { recursive: true, force: true });
  }
});

test('account parser rejects API-key auth as subscription login', () => {
  const account = parseCodexAccount({ account: { type: 'apiKey' } });
  assert.equal(account.loggedIn, false);
  assert.equal(account.method, 'apiKey');
});
