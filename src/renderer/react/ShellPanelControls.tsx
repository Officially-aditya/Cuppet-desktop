import { useEffect, useMemo } from 'react';

type PanelState = {
  leftAvailable: boolean;
  leftOpen: boolean;
  rightAvailable: boolean;
  rightOpen: boolean;
  bottomAvailable: boolean;
  bottomOpen: boolean;
};

type Props = {
  state: PanelState;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleBottom: () => void;
};

export function ShellPanelControls({ state, onToggleLeft, onToggleRight, onToggleBottom }: Props) {
  const isMac = window.cuppet.native.platform === 'darwin';
  useEffect(() => {
    if (!isMac) return;
    document.documentElement.classList.add('cuppet-shell-header');
    return () => document.documentElement.classList.remove('cuppet-shell-header');
  }, [isMac]);
  return useMemo(() => {
    if (!isMac) return null;
    return (
      <header className="shell-panel-header" aria-label="Workspace panel controls">
        <div className="shell-panel-controls shell-panel-controls-left">
          <button
            type="button"
            className={`shell-panel-button${state.leftOpen ? ' active' : ''}`}
            aria-label={state.leftOpen ? 'Hide left sidebar' : 'Show left sidebar'}
            title={state.leftOpen ? 'Hide left sidebar' : 'Show left sidebar'}
            disabled={!state.leftAvailable}
            onClick={onToggleLeft}
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
            onClick={onToggleRight}
          >
            <RightPanelIcon />
          </button>
          <button
            type="button"
            className={`shell-panel-button${state.bottomOpen ? ' active' : ''}`}
            aria-label={state.bottomOpen ? 'Hide terminal' : 'Show terminal'}
            title={state.bottomOpen ? 'Hide terminal' : 'Show terminal'}
            disabled={!state.bottomAvailable}
            onClick={onToggleBottom}
          >
            <BottomPanelIcon />
          </button>
        </div>
      </header>
    );
  }, [isMac, state, onToggleLeft, onToggleRight, onToggleBottom]);
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
