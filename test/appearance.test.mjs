import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('../src/renderer/react/appearance.ts', import.meta.url), 'utf8'));

async function fixture(t, { dark = false, saved = null } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  const media = new EventTarget();
  media.matches = dark;
  let value = saved;
  globalThis.window = Object.assign(new EventTarget(), { matchMedia: () => media });
  globalThis.document = { documentElement: { dataset: {}, style: {} } };
  globalThis.localStorage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  const appearance = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const dispose = appearance.installAppearance();
  t.after(() => {
    dispose();
    for (const [key, oldValue] of Object.entries(previous)) {
      if (oldValue === undefined) delete globalThis[key];
      else globalThis[key] = oldValue;
    }
  });
  return {
    appearance, dispose, saved: () => value,
    systemDark(next) { media.matches = next; media.dispatchEvent(new Event('change')); },
    theme: () => document.documentElement.dataset.theme,
  };
}

test('System default follows the OS appearance immediately and when it changes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.appearance.readAppearancePreference(), 'system');
  assert.equal(f.theme(), 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  f.systemDark(true);
  assert.equal(f.theme(), 'dark');
  f.systemDark(false);
  assert.equal(f.theme(), 'light');
});

test('Dark and Light override the OS and persist the chosen preference', async (t) => {
  const f = await fixture(t);
  f.appearance.writeAppearancePreference('dark');
  assert.equal(f.saved(), 'dark');
  assert.equal(f.theme(), 'dark');
  f.systemDark(true);
  f.systemDark(false);
  assert.equal(f.theme(), 'dark');
  f.appearance.writeAppearancePreference('light');
  f.systemDark(true);
  assert.equal(f.theme(), 'light');
  assert.equal(f.saved(), 'light');
  f.appearance.writeAppearancePreference('system');
  assert.equal(f.theme(), 'dark');
  f.systemDark(false);
  assert.equal(f.theme(), 'light');
});

test('a saved theme applies at startup before the interface mounts', async (t) => {
  const f = await fixture(t, { dark: true, saved: 'light' });
  assert.equal(f.theme(), 'light');
  assert.equal(f.appearance.readAppearancePreference(), 'light');
});

test('theme changes notify the terminal and provide readable terminal palettes', async (t) => {
  const f = await fixture(t, { saved: 'dark' });
  let palette = f.appearance.terminalAppearance();
  window.addEventListener(f.appearance.APPEARANCE_CHANGED_EVENT, () => { palette = f.appearance.terminalAppearance(); });
  assert.equal(palette.background, '#1e1e1e');
  f.appearance.writeAppearancePreference('light');
  assert.equal(palette.background, '#ffffff');
  assert.equal(palette.foreground, '#242f3e');
  f.appearance.writeAppearancePreference('dark');
  assert.equal(palette.background, '#1e1e1e');
  assert.equal(palette.foreground, '#c9d1d9');
});

test('invalid preferences use System default and disposing removes OS theme listeners', async (t) => {
  const f = await fixture(t, { saved: 'invalid' });
  assert.equal(f.appearance.readAppearancePreference(), 'system');
  assert.equal(f.theme(), 'light');
  f.dispose();
  f.systemDark(true);
  assert.equal(f.theme(), 'light');
});
