import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareManagedTstDataDir } from '../src/runtime/tst-data-alias.mjs';

test('managed TST keeps durable data persistent while shortening POSIX socket paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'cuppet-tst-alias-test-'));
  const durable = join(root, 'a-very-long-application-data-path', 'runtime', 'tst');
  const uid = `test-${process.pid}-${Date.now()}`;
  const alias = prepareManagedTstDataDir(durable, { platform: 'darwin', uid });
  try {
    assert.match(alias, /^\/tmp\/cuppet-tst-/);
    assert.equal(realpathSync(alias), realpathSync(durable));
    assert.ok(join(alias, 'run', '12345-0123456789abcdef', 'tst.sock').length < 104, 'macOS socket path must remain below sockaddr_un SUN_LEN');
  } finally {
    rmSync(join('/tmp', `cuppet-tst-${uid}`), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
