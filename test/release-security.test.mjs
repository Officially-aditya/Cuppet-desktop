import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAC_UPDATE_FEED_URL, isStableVersion, macUpdateEligibility } from '../src/main/auto-update-policy.mjs';
import { buildMacUpdateFeed } from '../scripts/build-macos-update-feed.mjs';

test('production updater is restricted to packaged stable arm64 macOS builds', () => {
  assert.equal(isStableVersion('1.2.3'), true);
  assert.equal(isStableVersion('1.2.3-alpha.1'), false);
  assert.deepEqual(macUpdateEligibility({ isPackaged: false, platform: 'darwin', arch: 'arm64', version: '1.2.3' }), { enabled: false, reason: 'development-build' });
  assert.deepEqual(macUpdateEligibility({ isPackaged: true, platform: 'linux', arch: 'arm64', version: '1.2.3' }), { enabled: false, reason: 'unsupported-platform' });
  assert.deepEqual(macUpdateEligibility({ isPackaged: true, platform: 'darwin', arch: 'x64', version: '1.2.3' }), { enabled: false, reason: 'unsupported-architecture' });
  assert.deepEqual(macUpdateEligibility({ isPackaged: true, platform: 'darwin', arch: 'arm64', version: '1.2.3-alpha.1' }), { enabled: false, reason: 'prerelease-or-invalid-version' });
  assert.deepEqual(macUpdateEligibility({ isPackaged: true, platform: 'darwin', arch: 'arm64', version: '1.2.3' }), { enabled: true, reason: null, feedURL: MAC_UPDATE_FEED_URL });
  assert.equal(MAC_UPDATE_FEED_URL, 'https://raw.githubusercontent.com/Officially-aditya/Cuppet-desktop/update-feed/macos/arm64/releases.json');
});

test('macOS update feed binds the release ZIP by URL, SHA-256, and byte size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-release-feed-'));
  const zipPath = join(dir, 'Cuppet-1.2.3-arm64.zip');
  const bytes = Buffer.from('signed-release-zip-fixture');
  await writeFile(zipPath, bytes);
  try {
    const feed = await buildMacUpdateFeed({ version: '1.2.3', tag: 'v1.2.3', zipPath, publishedAt: '2026-09-13T00:00:00.000Z' });
    assert.equal(feed.currentRelease, '1.2.3');
    assert.equal(feed.releases.length, 1);
    const update = feed.releases[0].updateTo;
    assert.equal(update.version, '1.2.3');
    assert.equal(update.url, 'https://github.com/Officially-aditya/Cuppet-desktop/releases/download/v1.2.3/Cuppet-1.2.3-arm64.zip');
    assert.equal(update.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(update.size, bytes.length);
    assert.equal(update.pub_date, '2026-09-13T00:00:00.000Z');
    await assert.rejects(buildMacUpdateFeed({ version: '1.2.3', tag: 'v1.2.4', zipPath }), /exactly match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
