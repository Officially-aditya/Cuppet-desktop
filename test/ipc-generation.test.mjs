import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('IPC generation checks accept Windows checkout line endings and still reject stale content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-ipc-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = ['src/preload/preload.cjs', 'src/renderer/ipc-api.d.ts'];
  for (const path of ['scripts/generate-ipc.mjs', 'src/shared/ipc-contract.mjs', ...generated]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), await readFile(new URL('../' + path, import.meta.url)));
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const check = () => spawnSync(process.execPath, ['scripts/generate-ipc.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check().status, 0);
  for (const path of ['scripts/generate-ipc.mjs', 'src/shared/ipc-contract.mjs', ...generated]) {
    const text = await readFile(join(root, path), 'utf8');
    await writeFile(join(root, path), text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }
  const windows = check();
  assert.equal(windows.status, 0, windows.stderr);
  await writeFile(join(root, generated[0]), (await readFile(join(root, generated[0]), 'utf8')) + '// stale manual edit\r\n');
  const stale = check();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Regenerate IPC contract/);
});
