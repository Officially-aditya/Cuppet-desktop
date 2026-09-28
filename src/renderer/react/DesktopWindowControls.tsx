import { useEffect, useState } from 'react';

/**
 * Custom desktop window controls (minimize, maximize/restore, close).
 * Inspired by ZCode's DesktopWindowControls for frameless desktop windows.
 */
export function DesktopWindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;

    const unsubscribe = window.cuppet?.native?.onWindowMaximizeChange?.((isMaximized: boolean) => {
      receivedEvent = true;
      if (!disposed) setMaximized(isMaximized);
    });

    void window.cuppet?.native?.isWindowMaximized?.()
      .then((isMaximized) => {
        if (!disposed && !receivedEvent) setMaximized(Boolean(isMaximized));
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return (
    <div className="desktop-window-controls" aria-label="Window controls">
      <button
        type="button"
        className="window-control-btn window-control-minimize"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void window.cuppet?.native?.minimizeWindow?.()}
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        className="window-control-btn window-control-maximize"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.cuppet?.native?.toggleMaximizeWindow?.()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        aria-label="Close window"
        title="Close"
        onClick={() => void window.cuppet?.native?.closeWindow?.()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
      <path d="M5.5 3.5h5a1.5 1.5 0 0 1 1.5 1.5v5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <rect x="3.5" y="5.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
      <path d="m4 4 8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
