import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Session } from '../types';

const SIDEBAR_WIDTH_KEY = 'cuppet.desktop.sidebar-width';
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 286;

type Props = {
  projects: Project[];
  sessions: Session[];
  generalSessions: Session[];
  activeSessionId: string | null;
  selectedProjectId: string | null;
  onNewChat: () => void;
  onNewProjectChat: (projectId: string) => void;
  onSearch: () => void;
  onRemote: () => void;
  onSettings: () => void;
  onAddProject: () => void;
  onProject: (projectId: string) => void | Promise<void>;
  onSession: (sessionId: string) => void | Promise<void>;
  onRenameProject: (project: Project) => void | Promise<void>;
  onRemoveProject: (project: Project) => void | Promise<void>;
  onRenameSession: (session: Session) => void | Promise<void>;
  onArchiveSession: (session: Session) => void | Promise<void>;
  onDeleteSession: (session: Session) => void | Promise<void>;
};

export function Sidebar(props: Props) {
  const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || DEFAULT_WIDTH));
  const [menu, setMenu] = useState<{ kind: 'project' | 'session'; id: string; x: number; y: number } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(clamp(event.clientX));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove('sidebar-resizing');
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [width]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('blur', close);
    document.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('blur', close);
      document.removeEventListener('pointerdown', close);
    };
  }, []);

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of props.sessions) {
      if (!session.projectId) continue;
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return map;
  }, [props.sessions]);

  const openMenu = (event: React.MouseEvent, kind: 'project' | 'session', id: string) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ kind, id, x: Math.min(event.clientX || event.currentTarget.getBoundingClientRect().right, window.innerWidth - 200), y: Math.min(event.clientY || event.currentTarget.getBoundingClientRect().bottom, window.innerHeight - 180) });
  };

  return (
    <aside className="sidebar react-sidebar" style={{ width, minWidth: width }}>
      <div className="sidebar-top">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">C</div>
          <div className="brand-title">Cuppet</div>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          <button type="button" className="nav-button" onClick={props.onNewChat}>New chat</button>
          <button type="button" className="nav-button" onClick={props.onSearch}>Search</button>
          <button type="button" className="nav-button" disabled>Agents</button>
          <button type="button" className="nav-button" onClick={props.onRemote}>Remote</button>
        </nav>
      </div>

      <div className="projects-header">
        <span>Projects</span>
        <button type="button" className="project-add-button" aria-label="Add project" title="Add project" onClick={props.onAddProject}>+</button>
      </div>

      <div className="project-list" aria-label="Projects and conversations">
        {props.projects.map((project) => (
          <section className="project-group" key={project.id}>
            <div className={`project-row${props.selectedProjectId === project.id ? ' active' : ''}`} onContextMenu={(event) => openMenu(event, 'project', project.id)}>
              <button type="button" className="project-button" title={projectMetadata(project)} onClick={() => void props.onProject(project.id)}>
                <span className="project-name">{project.name}</span>
              </button>
              <button
                type="button"
                className="project-new-chat-button"
                aria-label={`New chat in ${project.name}`}
                title={`New chat in ${project.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onNewProjectChat(project.id);
                }}
              >+</button>
              <button type="button" className="project-menu-button" aria-label={`Actions for ${project.name}`} title={`Actions for ${project.name}`} onClick={(event) => openMenu(event, 'project', project.id)}>⋯</button>
            </div>
            {(sessionsByProject.get(project.id) ?? []).map((session) => (
              <SessionRow key={session.id} session={session} active={props.activeSessionId === session.id} onOpen={props.onSession} onMenu={openMenu} />
            ))}
          </section>
        ))}

        {props.generalSessions.length > 0 && (
          <section className="project-group general-group">
            <div className="general-label">General</div>
            {props.generalSessions.map((session) => (
              <SessionRow key={session.id} session={session} active={props.activeSessionId === session.id} onOpen={props.onSession} onMenu={openMenu} />
            ))}
          </section>
        )}

        {!props.projects.length && !props.generalSessions.length && (
          <div className="sidebar-empty">No projects yet. Add a folder or clone a repository.</div>
        )}
      </div>

      <div className="sidebar-bottom">
        <button type="button" className="ghost-button full" onClick={props.onSettings}>Settings</button>
      </div>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          document.body.classList.add('sidebar-resizing');
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(DEFAULT_WIDTH));
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setWidth((value) => clamp(value - 10));
          if (event.key === 'ArrowRight') setWidth((value) => clamp(value + 10));
        }}
      />

      {menu && <ContextMenu {...props} menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function SessionRow({ session, active, onOpen, onMenu }: { session: Session; active: boolean; onOpen: (id: string) => void | Promise<void>; onMenu: (event: React.MouseEvent, kind: 'project' | 'session', id: string) => void }) {
  return (
    <div className="session-row" onContextMenu={(event) => onMenu(event, 'session', session.id)}>
      <button type="button" className={`session-item${active ? ' active' : ''}`} onClick={() => void onOpen(session.id)}>
        <div className="session-title">{session.title || 'New chat'}</div>
        <div className="session-meta">{session.lastStatus === 'streaming' ? 'Generating…' : relativeTime(session.updatedAt)}</div>
      </button>
      <button type="button" className="session-menu-button" aria-label={`Actions for ${session.title || 'chat'}`} onClick={(event) => onMenu(event, 'session', session.id)}>⋯</button>
    </div>
  );
}

function ContextMenu({ menu, onClose, projects, sessions, onRenameProject, onRemoveProject, onRenameSession, onArchiveSession, onDeleteSession }: Props & { menu: { kind: 'project' | 'session'; id: string; x: number; y: number }; onClose: () => void }) {
  const project = menu.kind === 'project' ? projects.find((item) => item.id === menu.id) : null;
  const session = menu.kind === 'session' ? sessions.find((item) => item.id === menu.id) : null;
  const run = (action: () => void | Promise<void>) => {
    onClose();
    void action();
  };

  return (
    <div className="nav-context-menu react-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      {project && <>
        <button type="button" onClick={() => run(() => onRenameProject(project))}>Rename project</button>
        <hr />
        <button type="button" className="danger" onClick={() => run(() => onRemoveProject(project))}>Remove project</button>
      </>}
      {session && <>
        <button type="button" onClick={() => run(() => onRenameSession(session))}>Rename chat</button>
        <button type="button" onClick={() => run(() => onArchiveSession(session))}>Archive chat</button>
        <hr />
        <button type="button" className="danger" onClick={() => run(() => onDeleteSession(session))}>Delete chat…</button>
      </>}
    </div>
  );
}

function clamp(value: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function projectMetadata(project: Project) {
  if (project.missing) return 'Folder missing';
  return [project.branch, project.dirty ? 'modified' : null].filter(Boolean).join(' · ') || 'Local folder';
}

function relativeTime(timestamp?: number) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
