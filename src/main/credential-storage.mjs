export function credentialStorageStatus(safeStorage, platform = process.platform) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    return { available: false, backend: null, reason: 'OS credential encryption is unavailable' };
  }

  if (platform !== 'linux') return { available: true, backend: platform, reason: null };

  let backend = 'unknown';
  try {
    if (typeof safeStorage.getSelectedStorageBackend === 'function') backend = String(safeStorage.getSelectedStorageBackend() || 'unknown');
  } catch {}

  if (backend === 'basic_text') {
    return { available: false, backend, reason: 'Linux secure credential storage is unavailable because Electron selected the unprotected basic_text backend' };
  }
  if (backend === 'unknown') {
    return { available: false, backend, reason: 'Linux credential storage backend is not ready' };
  }
  return { available: true, backend, reason: null };
}
