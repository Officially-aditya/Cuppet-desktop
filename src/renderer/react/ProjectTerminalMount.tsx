import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../types';
import { ProjectTerminal } from './ProjectTerminal';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';

export function ProjectTerminalMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<Project | null>(null);

  const sync = useCallback(async () => {
    const pane = document.querySelector<HTMLElement>('.react-main-pane');
    setTarget((current) => current === pane ? current : pane);

    const sessionId = localStorage.getItem(LAST_SESSION_KEY) || '';
    if (!sessionId) {
      setProject(null);
      return;
    }

    try {
      const session = await window.cuppet.sessions.get(sessionId);
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== sessionId) return;
      const projectId = typeof session?.projectId === 'string' ? session.projectId : '';
      if (!projectId) {
        setProject(null);
        return;
      }
      const nextProject = await window.cuppet.projects.get(projectId);
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== sessionId) return;
      setProject(nextProject?.missing ? null : nextProject);
    } catch {
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') === sessionId) setProject(null);
    }
  }, []);

  useEffect(() => {
    let scheduled = false;
    const requestSync = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void sync();
      });
    };

    requestSync();
    const observer = new MutationObserver(requestSync);
    observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
    const removeEvent = window.cuppet.onEvent((event) => {
      if (event?.type?.startsWith?.('session.') || event?.type === 'run.started' || event?.type === 'run.finished') requestSync();
    });
    const interval = window.setInterval(requestSync, 750);
    return () => {
      observer.disconnect();
      removeEvent();
      window.clearInterval(interval);
    };
  }, [sync]);

  return target ? createPortal(<ProjectTerminal project={project} />, target) : null;
}
