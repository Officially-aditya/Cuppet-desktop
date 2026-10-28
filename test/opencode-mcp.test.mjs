import assert from 'node:assert/strict';
import test from 'node:test';
import { openCodeMcpEnvironment } from '../src/runtime/providers/opencode-mcp.mjs';

test('OpenCode V2 child processes disable the duplicate browser server while preserving JSONC provider configuration', () => {
  const environment = { CUSTOM_PROVIDER_TOKEN: 'provider-owned', OPENCODE_CONFIG_CONTENT: `{
    // Preserve OpenCode's settings and other MCP servers.
    "providers": { "custom": { "settings": { "baseURL": "https://example.invalid" } } },
    "mcp": { "servers": { "browserControl": { "type": "local", "command": ["node", "browser.js"] }, "docs": { "type": "remote", "url": "https://example.invalid/mcp" } }, "timeout": { "startup": 1234 } },
  }` };
  const prepared = openCodeMcpEnvironment(environment, '2.0.27');
  const config = JSON.parse(prepared.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp.servers.browserControl, { type: 'local', command: ['node', 'browser.js'], disabled: true });
  assert.equal(config.mcp.servers.docs.url, 'https://example.invalid/mcp');
  assert.equal(config.mcp.timeout.startup, 1234);
  assert.equal(config.providers.custom.settings.baseURL, 'https://example.invalid');
  assert.equal(prepared.CUSTOM_PROVIDER_TOKEN, environment.CUSTOM_PROVIDER_TOKEN);
  assert.notEqual(prepared.OPENCODE_CONFIG_CONTENT, environment.OPENCODE_CONFIG_CONTENT);
});

test('managed V2 MCP override does not change V1 settings or add permission rules', () => {
  const environment = { OPENCODE_CONFIG_CONTENT: '{ invalid jsonc' };
  assert.equal(openCodeMcpEnvironment(environment, '1.18.30'), environment);
  const config = JSON.parse(openCodeMcpEnvironment({}, '2.0.27').OPENCODE_CONFIG_CONTENT);
  assert.equal(config.mcp.servers.browserControl.disabled, true);
  assert.equal(config.permissions, undefined);
  assert.equal(config.permission, undefined);
});

test('OpenCode V2 loads the private native steering plugin alongside existing plugins', () => {
  const prepared = openCodeMcpEnvironment({ OPENCODE_CONFIG_CONTENT: '{"plugins":["existing-plugin"]}' }, '2.0.27', [{
    name: 'cuppet-runtime', steering: { endpoint: '/tmp/private.sock', token: 'private-token' },
  }]);
  const config = JSON.parse(prepared.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.plugins[0], 'existing-plugin');
  assert.match(config.plugins[1].package, /opencode-steering$/);
  assert.deepEqual(config.plugins[1].options, { endpoint: '/tmp/private.sock', token: 'private-token' });
});
