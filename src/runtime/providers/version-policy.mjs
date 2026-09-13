const LOCAL_PROVIDER_VERSION_POLICIES = Object.freeze({
  opencode: Object.freeze({ minimumVersion: '1.18.30' }),
});

export function localProviderVersionPolicy(providerID) {
  const id = text(providerID).toLowerCase();
  const policy = LOCAL_PROVIDER_VERSION_POLICIES[id];
  return policy ? { ...policy } : null;
}

export function localProviderVersionCompatibility(providerID, versionLabel) {
  const policy = localProviderVersionPolicy(providerID);
  if (!policy) {
    return Object.freeze({
      required: false,
      supported: true,
      state: 'not_required',
      minimumVersion: null,
      observedVersion: parseSemanticVersion(versionLabel)?.label ?? null,
    });
  }

  const minimum = parseSemanticVersion(policy.minimumVersion);
  if (!minimum) throw new Error(`Invalid minimum version policy for ${text(providerID) || 'provider'}.`);
  const observed = parseSemanticVersion(versionLabel);
  if (!observed) {
    return Object.freeze({
      required: true,
      supported: false,
      state: 'unverified',
      minimumVersion: minimum.label,
      observedVersion: null,
    });
  }

  const supported = compareSemanticVersion(observed.parts, minimum.parts) >= 0;
  return Object.freeze({
    required: true,
    supported,
    state: supported ? 'compatible' : 'too_old',
    minimumVersion: minimum.label,
    observedVersion: observed.label,
  });
}

export function assertLocalProviderVersionSupported(providerID, versionLabel, providerLabel = '') {
  const compatibility = localProviderVersionCompatibility(providerID, versionLabel);
  if (compatibility.supported) return compatibility;
  const label = text(providerLabel) || text(providerID) || 'Provider';
  if (compatibility.state === 'too_old') {
    throw incompatibleVersionError(
      `${label} ${compatibility.observedVersion} is older than Cuppet's tested minimum ${compatibility.minimumVersion}. Upgrade ${label} before retrying.`,
      compatibility,
    );
  }
  throw incompatibleVersionError(
    `Cuppet could not verify ${label}'s version. ${label} ${compatibility.minimumVersion} or newer is required. Upgrade ${label} before retrying.`,
    compatibility,
  );
}

export function providerVersionUpgradeMessage(providerID, versionLabel, providerLabel = '', { managed = false } = {}) {
  const compatibility = localProviderVersionCompatibility(providerID, versionLabel);
  if (compatibility.supported) return '';
  const label = text(providerLabel) || text(providerID) || 'Provider';
  const requirement = `${label} ${compatibility.minimumVersion} or newer`;
  const observed = compatibility.observedVersion ? `${label} ${compatibility.observedVersion}` : `this ${label} installation`;
  return managed
    ? `${observed} is installed, but Cuppet requires ${requirement}. Reconnect to let Cuppet update its managed installation.`
    : `${observed} is installed, but Cuppet requires ${requirement}. Upgrade ${label} outside Cuppet, then retry.`;
}

export function parseSemanticVersion(value) {
  const source = text(value);
  const match = source.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return Object.freeze({ parts: Object.freeze(parts), label: parts.join('.') });
}

export function compareSemanticVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const a = Number(left?.[index] ?? 0);
    const b = Number(right?.[index] ?? 0);
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function incompatibleVersionError(message, compatibility) {
  const error = new Error(message);
  error.code = 'PROVIDER_VERSION_UNSUPPORTED';
  error.compatibility = compatibility;
  return error;
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
