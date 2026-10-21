import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWindowAppearance } from '../src/main/window-appearance.mjs';

test('window appearance restores preferences, follows native updates and persists the latest change', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-window-appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'appearance.json');
  await writeFile(path, JSON.stringify({ preference: 'light' }));
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const backgrounds = [];
  const appearance = await createWindowAppearance({
    nativeTheme, path, isMac: false,
    getWindow: () => ({ setBackgroundColor: (value) => backgrounds.push(value) }),
  });
  assert.equal(nativeTheme.themeSource, 'light');
  assert.equal(appearance.background(), '#ffffff');
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  assert.equal(backgrounds.at(-1), '#1e1e1e');
  await Promise.all([appearance.set('light'), appearance.set('dark')]);
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { preference: 'dark' });
  await assert.rejects(appearance.set('invalid'), /Invalid appearance/);
  assert.equal(nativeTheme.themeSource, 'dark');
  appearance.dispose();
  assert.equal(nativeTheme.listenerCount('updated'), 0);
});

test('missing or invalid appearance preferences use the system theme and preserve macOS transparency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-window-appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'appearance.json');
  for (const saved of [null, '{invalid', '{"preference":"unknown"}']) {
    if (saved !== null) await writeFile(path, saved);
    const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });
    const appearance = await createWindowAppearance({ nativeTheme, path, isMac: true, getWindow: () => null });
    assert.equal(nativeTheme.themeSource, 'system');
    assert.equal(appearance.background(), '#00000000');
    await appearance.set('light');
    appearance.dispose();
  }
});
