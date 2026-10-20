import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the approval panel is unchanged; a plain-language summary is the only addition, shown under it', async () => {
  const source = await read('../src/renderer/react/PermissionModal.tsx');
  // The panel and its command line stay exactly as they were.
  for (const kept of ['role="alert"', 'aria-labelledby="permission-title"', 'Permission required', "summarizeResources(resources)", 'title={resources.join(', 'function compact(value: string)', "normalized.length > 82"]) {
    assert.ok(source.includes(kept), `kept: ${kept}`);
  }
  // The actions are the original four, in the original order and wording; the summary adds no controls.
  assert.equal((source.match(/<button/g) ?? []).length, 4);
  const order = ['>Deny</button>', '>Auto</button>', '>Always</button>', '>Allow</button>'].map((label) => source.indexOf(label));
  assert.ok(order.every((index) => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]));
  assert.match(source, /aria-label="Enable guarded auto"/);
  assert.match(source, /title="Always allow this exact request"/);
  assert.equal((source.match(/permission-inline-button primary/g) ?? []).length, 1);
  // The summary is only for commands, comes after (below) the panel, and is generated synchronously, so it can never delay an approval.
  assert.match(source, /request\.action === 'bash' && resources\.length === 1/);
  assert.match(source, /plainLanguageSummary\(String\(resources\[0\]\)\)/);
  assert.ok(source.indexOf('</section>') < source.indexOf('permission-summary'));
  const computation = source.split('\n').find((line) => line.includes('plainLanguageSummary(String'));
  assert.ok(computation, 'summary computation found');
  assert.doesNotMatch(computation, /await|\.then\(|fetch\(|window\.cuppet|setTimeout/);
});

test('Settings explains what having no OS sandbox means, and only where commands would run unsandboxed', async () => {
  const source = await read('../src/renderer/react/SettingsModal.tsx');
  assert.match(source, /No OS sandbox on this system/);
  assert.match(source, /Shell commands run with your full user permissions, so the approval prompt is the only control/);
  // macOS and Linux refuse to run commands without a sandbox, so the "runs with your permissions" note must not show there.
  assert.match(source, /sandboxStatus\.platform !== 'darwin' && sandboxStatus\.platform !== 'linux'/);
});
