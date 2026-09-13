export type ProviderStatusPresentation = {
  credentialReady: boolean;
  badge: string;
  tone: 'ready' | 'muted' | 'warning';
  detail: string;
  runtimeState: string;
  capabilityState: string;
  canConnect: boolean;
};

export function providerStatusPresentation(status: unknown, providerLabel = 'Provider', busy = false): ProviderStatusPresentation {
  const source = record(status);
  const control = record(source.control);
  const runtime = record(control.runtime);
  const capabilities = record(control.capabilities);
  const overall = text(control.overall);
  const runtimeState = text(runtime.state) || 'stopped';
  const capabilityState = text(capabilities.state) || 'unknown';
  const installation = record(source.installation);
  const controlInstallation = record(control.installation);
  const compatibility = record(controlInstallation.compatibility);
  const installationKnown = typeof source.installed === 'boolean' || typeof installation.detected === 'boolean' || Boolean(overall);
  const installed = source.installed === true || installation.detected === true;
  const authenticated = record(control.authentication).state === 'authenticated'
    || source.connected === true
    || source.available === true;
  const credentialReady = authenticated
    && overall !== 'needs_install'
    && overall !== 'needs_update'
    && overall !== 'needs_auth';
  const fallback = text(source.message);

  if (busy) {
    return {
      credentialReady,
      badge: installed ? 'Connecting…' : 'Installing…',
      tone: 'muted',
      detail: fallback || `${providerLabel} setup is in progress.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (!status || !Object.keys(source).length || !installationKnown) {
    return {
      credentialReady: false,
      badge: 'Checking…',
      tone: 'muted',
      detail: fallback || `Checking ${providerLabel}…`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (overall === 'needs_install' || !installed) {
    return {
      credentialReady: false,
      badge: 'Not installed',
      tone: 'muted',
      detail: fallback || `${providerLabel} is not installed yet. Cuppet can install it when you connect.`,
      runtimeState,
      capabilityState,
      canConnect: true,
    };
  }

  if (overall === 'needs_update') {
    const minimumVersion = text(compatibility.minimumVersion);
    const observedVersion = text(compatibility.observedVersion);
    const requirement = minimumVersion ? `${providerLabel} ${minimumVersion} or newer` : `a supported ${providerLabel} version`;
    const observed = observedVersion ? `${providerLabel} ${observedVersion}` : `this ${providerLabel} installation`;
    return {
      credentialReady: false,
      badge: 'Update required',
      tone: 'warning',
      detail: fallback || `${observed} is not compatible with this Cuppet build. Install ${requirement}, then retry.`,
      runtimeState,
      capabilityState,
      canConnect: controlInstallation.canUpdate === true,
    };
  }

  if (overall === 'needs_auth' || !authenticated) {
    return {
      credentialReady: false,
      badge: 'Not connected',
      tone: 'muted',
      detail: fallback || `${providerLabel} is installed but still needs provider authentication.`,
      runtimeState,
      capabilityState,
      canConnect: true,
    };
  }

  if (overall === 'needs_retry' || runtimeState === 'crashed' || runtimeState === 'unhealthy') {
    const failure = record(runtime.lastFailure);
    const category = text(failure.category);
    const reason = category && category !== 'unknown' ? ` Last failure: ${humanize(category)}.` : '';
    return {
      credentialReady: true,
      badge: 'Needs retry',
      tone: 'warning',
      detail: `Authentication is still connected, but the local ${providerLabel} runtime stopped unexpectedly.${reason} Cuppet will rebuild it at the next safe request boundary.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (capabilityState === 'failed') {
    return {
      credentialReady: true,
      badge: 'Connected',
      tone: 'warning',
      detail: text(capabilities.error) || `${providerLabel} is authenticated, but model capability discovery failed.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (capabilityState === 'stale') {
    return {
      credentialReady: true,
      badge: runtimeState === 'busy' ? 'Working' : 'Connected',
      tone: 'warning',
      detail: text(capabilities.error) || `${providerLabel} is connected. Cuppet is using the last known model capabilities because the latest refresh failed.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (runtimeState === 'busy') {
    return {
      credentialReady: true,
      badge: 'Working',
      tone: 'ready',
      detail: fallback || `${providerLabel} is connected and currently handling a request.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  if (runtimeState === 'starting') {
    return {
      credentialReady: true,
      badge: 'Starting…',
      tone: 'ready',
      detail: fallback || `${providerLabel} is authenticated and its local runtime is starting.`,
      runtimeState,
      capabilityState,
      canConnect: false,
    };
  }

  return {
    credentialReady: true,
    badge: runtimeState === 'ready' ? 'Ready' : 'Connected',
    tone: 'ready',
    detail: runtimeState === 'stopped'
      ? `${providerLabel} is authenticated. Its local runtime is idle and will start on demand.`
      : fallback || `${providerLabel} is connected and ready to use in Cuppet.`,
    runtimeState,
    capabilityState,
    canConnect: false,
  };
}

function humanize(value: string) {
  return value.replace(/[_-]+/g, ' ');
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
