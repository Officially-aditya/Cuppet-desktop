import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './runtime-client.mjs';
import { ProviderSettingsStore } from './provider-settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let runtime;
let settings;
let mainWindow;

async function bootstrap() {
  const userData = app.getPath('userData');
  settings = new ProviderSettingsStore(join(userData, 'provider-settings.json'));
  await settings.load();

  runtime = new RuntimeClient({
    entry: join(here, '..', 'runtime', 'main.mjs'),
    dataDir: join(userData, 'runtime'),
  });
  runtime.on('event', (event) => mainWindow?.webContents.send('cuppet:event', event));
  runtime.on('exit', (info) => mainWindow?.webContents.send('cuppet:event', {
    type: 'runtime.error',
    message: `Runtime exited unexpectedly${info?.code !== null ? ` (code ${info.code})` : ''}`,
  }));
  await runtime.start();
  registerIpc();
  createWindow();
}

function registerIpc() {
  const request = (method, params) => runtime.request(method, params);
  ipcMain.handle('cuppet:health', () => request('health'));
  ipcMain.handle('cuppet:session:list', () => request('session.list'));
  ipcMain.handle('cuppet:session:create', () => request('session.create'));
  ipcMain.handle('cuppet:session:get', (_event, sessionId) => request('session.get', { sessionId }));
  ipcMain.handle('cuppet:session:send', (_event, sessionId, text) => request('session.send', {
    sessionId,
    text,
    provider: settings.runtimeValue(),
  }));
  ipcMain.handle('cuppet:session:stop', (_event, sessionId) => request('session.stop', { sessionId }));
  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());
  ipcMain.handle('cuppet:settings:save', (_event, value) => settings.save(value));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    show: false,
    backgroundColor: '#0d0f12',
    title: 'Cuppet',
    webPreferences: {
      preload: join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(join(here, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtime) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { void runtime?.stop(); });
