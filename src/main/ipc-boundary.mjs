import { IPC_METHODS, validateIpcArguments } from '../shared/ipc-contract.mjs';

export function createIpcRegistrar({ ipcMain, getWindow, rendererUrl }) {
  return (name, listener) => {
    const spec = IPC_METHODS[name];
    if (!spec) throw new Error('Unknown IPC method: ' + name);
    ipcMain.handle(spec.channel, (event, ...args) => {
      const contents = getWindow()?.webContents;
      const frame = event.senderFrame;
      if (!contents || contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) {
        throw new Error('Untrusted IPC sender');
      }
      const url = new URL(frame.url);
      url.hash = '';
      url.search = '';
      if (url.href !== rendererUrl) throw new Error('Untrusted IPC document');
      validateIpcArguments(name, args);
      return listener(event, ...args);
    });
  };
}
