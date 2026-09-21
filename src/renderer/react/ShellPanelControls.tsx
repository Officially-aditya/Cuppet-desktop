import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

type PanelState = {
  leftAvailable: boolean;
  leftOpen: boolean;
  rightAvailable?: boolean;
  rightOpen?: boolean;
  bottomAvailable: boolean;
  bottomOpen: boolean;
};

type Props = {
  project?: Project | null;
  state: PanelState;
  onToggleLeft: () => void;
  onToggleRight?: () => void;
  onToggleBottom: () => void;
};

export function ShellPanelControls({ project, state, onToggleLeft, onToggleRight, onToggleBottom }: Props) {
  const isMac = window.cuppet.native.platform === 'darwin';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMac) return;
    document.documentElement.classList.add('cuppet-shell-header');
    return () => document.documentElement.classList.remove('cuppet-shell-header');
  }, [isMac]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

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
        <div className="shell-panel-header-center" ref={menuRef}>
          <button
            type="button"
            className={`project-header-button${menuOpen ? ' active' : ''}`}
            title={`Project: ${project.name} · Click for project menu`}
            aria-label={`Project: ${project.name} · Click for project menu`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <span className="project-header-name">
              {project.name}
            </span>
            <svg className={`project-header-chevron${menuOpen ? ' open' : ''}`} viewBox="0 0 16 16" fill="none" width="10" height="10">
              <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
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

          {menuOpen && (
            <div className="project-header-dropdown" role="menu">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onToggleRight?.();
                }}
              >
                <GraphIcon />
                <span>{state.rightOpen ? 'Hide project graph' : 'Show project graph'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onToggleBottom?.();
                }}
              >
                <BottomPanelIcon />
                <span>{state.bottomOpen ? 'Hide terminal' : 'Show terminal'}</span>
              </button>
              {project.path && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void window.cuppet.projects.open(project.id).catch(() => undefined);
                  }}
                >
                  <FolderIcon />
                  <span>Open in Finder</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="shell-panel-controls shell-panel-controls-right">
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
}

function GitBranchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M4.5 5v6M11.5 7c0 2-2 3-5 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M5.5 5.5 7 10.5M10.5 5.5 9 10.5M6 4h4" stroke="currentColor" strokeWidth="1.2"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.293a1.5 1.5 0 0 1 1.06.44l1.147 1.146a.5.5 0 0 0 .354.147H13A1.5 1.5 0 0 1 14.5 5.23V12.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3.5Z" stroke="currentColor" strokeWidth="1.3"/>
    </svg>
  );
}

function LeftPanelIcon() {
  return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.25"/><path d="M7 3v12" stroke="currentColor" strokeWidth="1.25"/></svg>;
}

function BottomPanelIcon() {
  return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="13" height="12" rx="2.2" stroke="currentColor" strokeWidth="1.25"/><path d="M2.5 10.5h13" stroke="currentColor" strokeWidth="1.25"/></svg>;
}
