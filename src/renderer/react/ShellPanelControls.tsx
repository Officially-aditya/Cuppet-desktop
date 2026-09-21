import { useEffect, useMemo } from 'react';
import type { Project } from '../types';

type PanelState = {
  leftAvailable: boolean;
  leftOpen: boolean;
  rightAvailable: boolean;
  rightOpen: boolean;
  bottomAvailable: boolean;
  bottomOpen: boolean;
};

type Props = {
  project?: Project | null;
  state: PanelState;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleBottom: () => void;
};

export function ShellPanelControls({ project, state, onToggleLeft, onToggleRight, onToggleBottom }: Props) {
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

        {project && (
          <div className="shell-panel-header-center">
            <span className="project-header-name" title={project.path || project.name}>
              {project.name}
            </span>
            {project.branch && (
              <span className="project-branch-badge" title={`Git branch: ${project.branch}`}>
                <GitBranchIcon />
                <span>{project.branch}</span>
              </span>
            )}
            {project.dirty && (
              <span className="project-dirty-indicator" title="Uncommitted changes in workspace" aria-label="Uncommitted changes">
                ●
              </span>
            )}
          </div>
        )}

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
  }, [isMac, project, state, onToggleLeft, onToggleRight, onToggleBottom]);
}

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M4.5 5v6M11.5 7c0 2-2 3-5 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
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
