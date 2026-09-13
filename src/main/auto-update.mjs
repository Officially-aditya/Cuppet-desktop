import { app, autoUpdater } from 'electron';
import { MAC_UPDATE_FEED_URL, macUpdateEligibility } from './auto-update-policy.mjs';

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function installMacAutoUpdater({ logger = console } = {}) {
  const policy = macUpdateEligibility({
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  });
  if (!policy.enabled) return policy;

  let checking = false;
  const log = (level, message) => {
    try { logger?.[level]?.(message); } catch { /* diagnostics must never affect startup */ }
  };

  autoUpdater.setFeedURL({ url: MAC_UPDATE_FEED_URL, serverType: 'json' });
  autoUpdater.on('checking-for-update', () => { checking = true; });
  autoUpdater.on('update-available', () => { checking = false; log('info', 'Cuppet update available; download started.'); });
  autoUpdater.on('update-not-available', () => { checking = false; });
  autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
    checking = false;
    log('info', `Cuppet update downloaded${releaseName ? ` (${String(releaseName).slice(0, 80)})` : ''}; it will install on the next app launch.`);
  });
  autoUpdater.on('error', (error) => {
    checking = false;
    const message = String(error?.message ?? error ?? 'unknown updater error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 240);
    log('warn', `Cuppet update check failed: ${message}`);
  });

  const check = () => {
    if (checking) return false;
    checking = true;
    try {
      autoUpdater.checkForUpdates();
      return true;
    } catch (error) {
      checking = false;
      const message = String(error?.message ?? error ?? 'unknown updater error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 240);
      log('warn', `Cuppet update check failed: ${message}`);
      return false;
    }
  };

  const initialTimer = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  initialTimer.unref?.();
  const intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
  intervalTimer.unref?.();

  return { ...policy, check };
}
