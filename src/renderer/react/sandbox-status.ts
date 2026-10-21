import { useEffect, useState } from 'react';
import type { SandboxStatus } from '../types';

/**
 * True when shell commands run with no OS sandbox at all. Without a sandbox macOS and Linux refuse to run commands,
 * so only other platforms (Windows) can end up here; there the user's own permissions apply and the approval
 * prompt is the only control.
 */
export function isUnsandboxed(status: SandboxStatus | null | undefined) {
  return Boolean(status && !status.available && status.platform !== 'darwin' && status.platform !== 'linux');
}

/** The sandbox status reported by the main process, or null until it is known (or when it cannot be read). */
export function useSandboxStatus(): SandboxStatus | null {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(window.cuppet?.sandbox?.status?.()).then(
      (next) => { if (live && next) setStatus(next); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);
  return status;
}
