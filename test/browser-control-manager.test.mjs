import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BrowserControlManager } from '../src/runtime/browser-control-manager.mjs';

const entry = fileURLToPath(new URL('./fixtures/fake-browser-control.mjs', import.meta.url));
const statusTool = { name: 'browser_status', description: 'Test browser status', inputSchema: { type: 'object', properties: {} } };
const inspectTool = { name: 'browser_inspect', description: 'Inspect the refreshed page', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } };

function setup(t, { connected = true } = {}) {
  const health = { connected, startupProbe: true };
  const events = [];
  t.mock.method(globalThis, 'fetch', async () => {
    if (health.startupProbe) {
      health.startupProbe = false;
      return { ok: false };
    }
    return { ok: true, async json() { return { ok: true, service: 'browsercontrol-local', extensionConnected: health.connected }; } };
  });
  const manager = new BrowserControlManager({ entry, emit: (event) => events.push(event) });
  t.after(() => manager.close());
  return { manager, health, events };
}

async function configure(manager, args = {}) {
  return JSON.parse((await manager.call('browser_status', args)).output);
}

async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for browserControl tool refresh');
}

test('connect refreshes tools and schemas and reconnect discards the previous tool list', async (t) => {
  const { manager, health, events } = setup(t);
  assert.equal((await manager.connect()).connected, true);
  const original = await configure(manager);
  await configure(manager, { tools: [statusTool, inspectTool, { name: 'browser_tabs', inputSchema: { type: 'object', properties: {} } }] });
  const connected = await manager.connect();
  assert.equal(connected.toolCount, 3);
  assert.equal(connected.connected, true);
  const inspect = manager.definitions().find((tool) => tool.function.name === 'browser_inspect');
  assert.match(inspect.function.description, /Inspect the refreshed page/);
  assert.deepEqual(inspect.function.parameters, inspectTool.inputSchema);
  assert.equal((await configure(manager)).pid, original.pid);
  assert.equal(events.at(-1).status.toolCount, 3);

  await configure(manager, { tools: [statusTool], listError: true });
  await assert.rejects(manager.connect(), /Test tools\/list failure/);
  assert.equal(manager.has('browser_inspect'), true);
  assert.equal(manager.definitions().length, 3);
  await configure(manager, { listError: false });
  assert.equal((await manager.connect()).toolCount, 1);
  assert.equal(manager.has('browser_inspect'), false);

  assert.equal((await manager.disconnect()).running, false);
  assert.deepEqual(manager.definitions(), []);
  await assert.rejects(manager.reloadTools(), /Connect Chrome before reloading/);
  health.startupProbe = true;
  assert.equal((await manager.connect()).toolCount, 1);
  assert.equal(manager.has('browser_inspect'), false);
  assert.notEqual((await configure(manager)).pid, original.pid);
});

test('MCP notifications and Chrome reconnection refresh the tool list automatically', async (t) => {
  const { manager, health, events } = setup(t);
  await manager.connect();
  await configure(manager, { tools: [statusTool, inspectTool], notify: true });
  await waitFor(() => manager.has('browser_inspect'));
  await waitFor(() => events.at(-1)?.status.toolCount === 2);

  await configure(manager, { tools: [statusTool], listError: true, notify: true });
  await waitFor(() => events.some((event) => /Test tools\/list failure/.test(event.status?.message)));
  assert.equal(manager.has('browser_inspect'), true);
  await configure(manager, { listError: false });
  health.connected = false;
  assert.equal((await manager.status()).connected, false);
  assert.deepEqual(manager.definitions(), []);
  health.connected = true;
  const status = await manager.status();
  assert.equal(status.connected, true);
  assert.equal(status.toolCount, 1);
  assert.equal(manager.has('browser_inspect'), false);
});

test('Chrome connecting after setup reloads tools before exposing them', async (t) => {
  const { manager, health } = setup(t, { connected: false });
  const status = await manager.connect();
  assert.equal(status.running, true);
  assert.equal(status.connected, false);
  assert.deepEqual(manager.definitions(), []);
  health.connected = true;
  assert.equal((await manager.status()).connected, true);
  const before = await configure(manager);
  await configure(manager, { tools: [statusTool, inspectTool] });
  health.connected = false;
  await manager.status();
  health.connected = true;
  await manager.status();
  assert.equal(manager.has('browser_inspect'), true);
  assert.ok((await configure(manager)).listRequests > before.listRequests);
});

test('overlapping reloads share a request and disconnect cancels a pending reload', async (t) => {
  const { manager } = setup(t);
  await manager.connect();
  const before = await configure(manager, { tools: [statusTool, inspectTool], listDelay: 50 });
  const results = await Promise.all([manager.reloadTools(), manager.reloadTools()]);
  assert.ok(results.every((status) => status.toolCount === 2));
  assert.equal((await configure(manager)).listRequests, before.listRequests + 1);

  await configure(manager, { listDelay: 500 });
  const pending = manager.reloadTools();
  const rejected = assert.rejects(pending, /runtime stopped/);
  await manager.disconnect();
  await rejected;
  assert.deepEqual(manager.definitions(), []);
});
