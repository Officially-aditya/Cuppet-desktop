export const MAC_UPDATE_FEED_URL = 'https://raw.githubusercontent.com/Officially-aditya/Cuppet-desktop/update-feed/macos/arm64/releases.json';

export function macUpdateEligibility({ isPackaged, platform, arch, version } = {}) {
  if (!isPackaged) return { enabled: false, reason: 'development-build' };
  if (platform !== 'darwin') return { enabled: false, reason: 'unsupported-platform' };
  if (arch !== 'arm64') return { enabled: false, reason: 'unsupported-architecture' };
  if (!isStableVersion(version)) return { enabled: false, reason: 'prerelease-or-invalid-version' };
  return { enabled: true, reason: null, feedURL: MAC_UPDATE_FEED_URL };
}

export function isStableVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value ?? '').trim());
}
