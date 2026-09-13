import { useEffect, useState } from 'react';

type PanelState = {
  leftAvailable: boolean;
  leftOpen: boolean;
  rightAvailable: boolean;
  rightOpen: boolean;
  bottomAvailable: boolean;
  bottomOpen: boolean;
};

const EMPTY_STATE: PanelState = {
  leftAvailable: false,
  leftOpen: true,
  rightAvailable: false,
  rightOpen: false,
  bottomAvailable: false,
  bottomOpen: false,
};

export function ShellPanelControls() {
  const isMac = window.cuppet.native.platform === 'darwin';
  const [state, setState] = useState<PanelState>(EMPTY_STATE);

  useEffect(() => {
    if (!isMac) return;
    document.documentElement.classList.add('cuppet-shell-header');

    let scheduled = false;
    const sync = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const next = readPanelState();
        setState((current) => samePanelState(current, next) ? current : next);
      });
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.getElementById('root') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    window.addEventListener('resize', sync);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      document.documentElement.classList.remove('cuppet-shell-header');
    };
  }, [isMac]);

  if (!isMac) return null;

  const toggleLeft = () => clickFirst('.sidebar-toggle-button');
  const toggleRight = () => clickFirst('.memory-sidebar [aria-label="Hide memory sidebar"], .memory-sidebar-rail');
  const toggleBottom = () => clickFirst('.project-terminal-bar');

  return (
    <header className="shell-panel-header" aria-label="Workspace panel controls">
      <div className="shell-panel-controls shell-panel-controls-left">
        <button
          type="button"
          className={`shell-panel-button${state.leftOpen ? ' active' : ''}`}
          aria-label={state.leftOpen ? 'Hide left sidebar' : 'Show left sidebar'}
          title={state.leftOpen ? 'Hide left sidebar' : 'Show left sidebar'}
          disabled={!state.leftAvailable}
          onClick={toggleLeft}
        >
          <LeftPanelIcon />
        </button>
      </div>

      <div className="shell-panel-controls shell-panel-controls-right">
        <button
          type="button"
          className={`shell-panel-button${state.rightOpen ? ' active' : ''}`}
          aria-label={state.rightOpen ? 'Hide project graph' : 'Show project graph'}
          title={state.rightOpen ? 'Hide project graph' : 'Show project graph'}
          disabled={!state.rightAvailable}
          onClick={toggleRight}
        >
          <RightPanelIcon />
        </button>
        <button
          type="button"
          className={`shell-panel-button${state.bottomOpen ? ' active' : ''}`}
          aria-label={state.bottomOpen ? 'Hide terminal' : 'Show terminal'}
          title={state.bottomOpen ? 'Hide terminal' : 'Show terminal'}
          disabled={!state.bottomAvailable}
          onClick={toggleBottom}
        >
          <BottomPanelIcon />
        </button>
      </div>
    </header>
  );
}

function readPanelState(): PanelState {
  const sidebar = document.querySelector<HTMLElement>('.react-sidebar');
  const memory = document.querySelector<HTMLElement>('.memory-sidebar');
  const memoryRail = document.querySelector<HTMLElement>('.memory-sidebar-rail');
  const terminal = document.querySelector<HTMLElement>('.project-terminal');
  return {
    leftAvailable: Boolean(sidebar && document.querySelector('.sidebar-toggle-button')),
    leftOpen: Boolean(sidebar && !sidebar.classList.contains('collapsed')),
    rightAvailable: Boolean(memory || memoryRail),
    rightOpen: Boolean(memory),
    bottomAvailable: Boolean(terminal),
    bottomOpen: Boolean(terminal?.classList.contains('open')),
  };
}

function samePanelState(left: PanelState, right: PanelState) {
  return left.leftAvailable === right.leftAvailable
    && left.leftOpen === right.leftOpen
    && left.rightAvailable === right.rightAvailable
    && left.rightOpen === right.rightOpen
    && left.bottomAvailable === right.bottomAvailable
    && left.bottomOpen === right.bottomOpen;
}

function clickFirst(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)?.click();
}

function LeftPanelIcon() {
  return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.25"/><path d="M7 3v12" stroke="currentColor" strokeWidth="1.25"/></svg>;
}

function RightPanelIcon() {
  return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.25"/><path d="M11 3v12" stroke="currentColor" strokeWidth="1.25"/></svg>;
}

function BottomPanelIcon() {
  return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.25"/><path d="M2.5 10.5h13" stroke="currentColor" strokeWidth="1.25"/></svg>;
}
