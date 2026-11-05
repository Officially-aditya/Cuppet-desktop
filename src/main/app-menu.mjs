// The native application menu. Security, privacy and About live under Help instead of Settings,
// because they explain how Cuppet works and have nothing to configure.
// Electron's stock Edit/View/Window roles are kept so clipboard shortcuts and window handling behave as before.

export const HELP_TOPICS = Object.freeze(['security', 'privacy', 'about']);

export function buildMenuTemplate({ isMac, appName = 'Cuppet', openHelp, canOpenHelp = true }) {
  // Help entries need a window to show the topic in. macOS keeps the menu bar after the last window closes.
  const helpItem = (label, topic) => ({ label, enabled: canOpenHelp, click: () => openHelp(topic) });
  const helpMenu = {
    role: 'help',
    label: 'Help',
    submenu: [
      helpItem('Security & Sandbox', 'security'),
      helpItem('Data & Privacy', 'privacy'),
      { type: 'separator' },
      helpItem(`About ${appName}`, 'about'),
    ],
  };
  const first = isMac
    ? {
      label: appName,
      submenu: [
        helpItem(`About ${appName}`, 'about'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }
    : { role: 'fileMenu' };
  return [first, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, helpMenu];
}

export function installApplicationMenu({ Menu, isMac, appName, openHelp, canOpenHelp }) {
  const menu = Menu.buildFromTemplate(buildMenuTemplate({ isMac, appName, openHelp, canOpenHelp }));
  Menu.setApplicationMenu(menu);
  return menu;
}
