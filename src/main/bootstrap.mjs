import { app, BrowserWindow, session, shell } from 'electron';
import { installCodexAuthIpc } from './codex-auth.mjs';
import { applyLocalCliEnvironment } from '../runtime/local-cli-environment.mjs';

const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  // LaunchServices/Finder starts macOS apps with launchd's reduced PATH. Recover
  // only the user's login-shell PATH before importing the desktop runtime so the
  // runtime child and Settings probes resolve the same local CLIs as Terminal.
  applyLocalCliEnvironment();
  installSecurityGuards();
  installCodexAuthIpc();
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  await import('./main.mjs');
}

function installSecurityGuards() {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (safeExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const current = contents.getURL();
      if (!sameLocalDocument(current, url)) event.preventDefault();
    });
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
  });
}

function sameLocalDocument(current, next) {
  try {
    const currentUrl = new URL(current);
    const nextUrl = new URL(next);
    return currentUrl.protocol === 'file:' && nextUrl.protocol === 'file:' && currentUrl.pathname === nextUrl.pathname;
  } catch {
    return false;
  }
}

function safeExternalUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}
