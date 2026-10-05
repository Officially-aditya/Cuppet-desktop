export type AppearancePreference = 'system' | 'dark' | 'light';

const PREF_APPEARANCE = 'cuppet.desktop.pref.appearance';
export const APPEARANCE_CHANGED_EVENT = 'cuppet:appearance-changed';
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function readAppearancePreference(): AppearancePreference {
  try {
    const value = localStorage.getItem(PREF_APPEARANCE);
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function writeAppearancePreference(preference: AppearancePreference) {
  localStorage.setItem(PREF_APPEARANCE, preference);
  applyAppearance(preference, window.matchMedia(SYSTEM_DARK_QUERY).matches);
}

export function installAppearance() {
  const system = window.matchMedia(SYSTEM_DARK_QUERY);
  const update = () => applyAppearance(readAppearancePreference(), system.matches);
  update();
  system.addEventListener('change', update);
  return () => system.removeEventListener('change', update);
}

function applyAppearance(preference: AppearancePreference, systemDark: boolean) {
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  document.documentElement.style.colorScheme = theme;
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
}

export function terminalAppearance() {
  if (document.documentElement.dataset.theme === 'light') return {
    background: '#ffffff', foreground: '#242f3e', cursor: '#2563eb', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(37,99,235,.18)', selectionForeground: '#17212e',
    black: '#242f3e', red: '#b42318', green: '#18723b', yellow: '#8f650d', blue: '#2563eb',
    magenta: '#7e3fbd', cyan: '#0e7490', white: '#657184', brightBlack: '#657184',
    brightRed: '#c9342b', brightGreen: '#218348', brightYellow: '#a17614', brightBlue: '#1d4ed8',
    brightMagenta: '#9333ea', brightCyan: '#0891b2', brightWhite: '#17212e',
  };
  return {
    background: '#1e1e1e', foreground: '#c9d1d9', cursor: '#58a6ff', cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(56,139,253,.35)', selectionForeground: '#ffffff',
    black: '#0d1117', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
    magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4', brightBlack: '#6e7681',
    brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  };
}
