import { readFile, writeFile } from 'node:fs/promises';

const preferences = new Set(['system', 'light', 'dark']);

export async function createWindowAppearance({ nativeTheme, path, getWindow, isMac }) {
  let preference = 'system';
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (preferences.has(saved.preference)) preference = saved.preference;
  } catch { /* A first launch or invalid file uses the OS appearance. */ }
  nativeTheme.themeSource = preference;
  const background = () => isMac ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff';
  const update = () => getWindow()?.setBackgroundColor(background());
  nativeTheme.on('updated', update);
  let saving = Promise.resolve();
  return {
    background,
    async set(value) {
      if (!preferences.has(value)) throw new Error('Invalid appearance preference.');
      preference = value;
      nativeTheme.themeSource = value;
      update();
      saving = saving.catch(() => {}).then(() => writeFile(path, JSON.stringify({ preference: value }) + '\n', 'utf8'));
      await saving;
      return { preference };
    },
    dispose() { nativeTheme.removeListener('updated', update); },
  };
}
