import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './runtime-client.mjs';
import { maybeRunGuiCliSmoke } from './gui-cli-smoke.mjs';

const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const runtime = new RuntimeClient({
    entry: join(here, '..', 'runtime', 'main.mjs'),
    dataDir: join(userData, 'runtime'),
    environment: { CUPPET_USER_DATA_DIR: userData },
  });
  try {
    await runtime.start();
    const handled = await maybeRunGuiCliSmoke({ runtime });
    if (!handled) throw new Error('Internal GUI CLI smoke entry was started without its acceptance flag.');
  } finally {
    await runtime.stop().catch(() => undefined);
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
