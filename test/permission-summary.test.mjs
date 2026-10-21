import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the plain-language summary is informational: only for commands, below the panel, and computed synchronously', async () => {
  const source = await read('../src/renderer/react/PermissionModal.tsx');
  // The summary adds no controls and is only for a single shell command.
  assert.match(source, /request\.action === 'bash' && resources\.length === 1/);
  assert.match(source, /plainLanguageSummary\(String\(resources\[0\]\)\)/);
  // It comes after (below) the panel, so the command and the choices are never pushed out of view by it.
  assert.ok(source.indexOf('</section>') < source.indexOf('className="permission-summary"'));
  // It is generated synchronously, so it can never delay an approval.
  const computation = source.split('\n').find((line) => line.includes('plainLanguageSummary(String'));
  assert.ok(computation, 'summary computation found');
  assert.doesNotMatch(computation, /await|\.then\(|fetch\(|window\.cuppet|setTimeout/);
});

test('Settings explains what having no OS sandbox means, and only where commands would run unsandboxed', async () => {
  const source = await read('../src/renderer/react/SettingsModal.tsx');
  assert.match(source, /No OS sandbox on this system/);
  assert.match(source, /Shell commands run with your full user permissions, so the approval prompt is the only control/);
  // The condition is shared with the approval prompt rather than copied: macOS and Linux refuse to run commands
  // without a sandbox, so the "runs with your permissions" note must not show there.
  assert.match(source, /isUnsandboxed\(sandboxStatus\)/);
  const helper = await read('../src/renderer/react/sandbox-status.ts');
  assert.match(helper, /status\.platform !== 'darwin' && status\.platform !== 'linux'/);
});
