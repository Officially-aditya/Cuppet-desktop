import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GUI smoke crosses hydrated bootstrap into the real runtime child', async () => {
  const bootstrap = await readFile(new URL('../src/main/bootstrap.mjs', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../src/main/gui-cli-smoke-entry.mjs', import.meta.url), 'utf8');
  const smoke = await readFile(new URL('../src/main/gui-cli-smoke.mjs', import.meta.url), 'utf8');

  const hydrate = bootstrap.indexOf('applyLocalCliEnvironment();');
  const smokeImport = bootstrap.indexOf("await import('./gui-cli-smoke-entry.mjs')");
  assert.ok(hydrate >= 0 && smokeImport > hydrate, 'login-shell PATH must be recovered before GUI smoke runtime startup');
  assert.match(entry, /new RuntimeClient\(/);
  assert.match(entry, /await runtime\.start\(\)/);
  assert.match(smoke, /runtime\.request\('provider\.local\.status', \{ providerID: 'opencode' \}/);
  assert.doesNotMatch(smoke, /localProviderOperations|cliAgentStatus/);
});

test('LaunchServices acceptance does not launch the app executable directly', async () => {
  const source = await readFile(new URL('../scripts/smoke-launchservices-cli-path.mjs', import.meta.url), 'utf8');
  assert.match(source, /'\/usr\/bin\/open'/);
  assert.match(source, /'\/bin\/launchctl'/);
  assert.match(source, /CUPPET_INTERNAL_GUI_CLI_SMOKE/);
  assert.match(source, /__CUPPET_LOGIN_SHELL_PATH__/);
  assert.match(source, /provider control plane resolved authenticated OpenCode/);
  assert.doesNotMatch(source, /Contents\/MacOS\/cuppet/);
});
