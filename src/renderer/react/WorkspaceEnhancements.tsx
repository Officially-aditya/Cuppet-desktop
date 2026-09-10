import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';

type EditedFile = { path: string; tool?: string; updatedAt?: number };
type EditedFilesResult = { sessionId: string; projectId?: string | null; files?: EditedFile[] };

export function WorkspaceEnhancements() {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [files, setFiles] = useState<EditedFile[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  const sync = useCallback(async () => {
    const id = localStorage.getItem(LAST_SESSION_KEY) || '';
    const hasConversation = Boolean(document.querySelector('.react-messages .message[data-message-id]'));
    if (!id || !hasConversation) {
      setSessionId('');
      setProjectId(null);
      setFiles([]);
      setOpen(false);
      return;
    }
    try {
      const result = await (window.cuppet.sessions as any).editedFiles(id) as EditedFilesResult;
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== id) return;
      setSessionId(id);
      setProjectId(typeof result?.projectId === 'string' ? result.projectId : null);
      setFiles(Array.isArray(result?.files) ? result.files.filter((item) => item && typeof item.path === 'string').slice(0, 128) : []);
      setError('');
    } catch {
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== id) return;
      setSessionId(id);
      setProjectId(null);
      setFiles([]);
    }
  }, []);

  useEffect(() => {
    let node: HTMLDivElement | null = null;
    const install = () => {
      if (node?.isConnected) return true;
      const footer = document.querySelector('.react-composer-wrap');
      const composer = footer?.querySelector('.react-composer');
      if (!(footer instanceof HTMLElement) || !(composer instanceof HTMLElement)) return false;
      node = document.createElement('div');
      node.className = 'workspace-edited-files-mount';
      footer.insertBefore(node, composer);
      setMount(node);
      return true;
    };
    if (install()) return () => { node?.remove(); setMount(null); };
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); node?.remove(); setMount(null); };
  }, []);

  useEffect(() => {
    let scheduled = false;
    const requestSync = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; void sync(); });
    };
    requestSync();
    const messages = document.querySelector('.react-messages');
    const observer = new MutationObserver(requestSync);
    if (messages) observer.observe(messages, { childList: true, subtree: true });
    const removeEvent = window.cuppet.onEvent((event) => {
      if (event?.type === 'run.finished' || event?.type === 'mutation.undone' || event?.type === 'session.restored' || event?.type === 'session.deleted' || event?.type === 'session.purged') requestSync();
      if (event?.type === 'tool.finished' && event?.mutation === true) window.setTimeout(requestSync, 80);
    });
    return () => { observer.disconnect(); removeEvent(); };
  }, [mount, sync]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cuppet-project-file], [data-cuppet-external]') : null;
      if (!element) return;
      const external = element.getAttribute('data-cuppet-external');
      const filePath = element.getAttribute('data-cuppet-project-file');
      if (external) {
        const href = element instanceof HTMLAnchorElement ? element.href : element.getAttribute('href') || '';
        if (!href) return;
        event.preventDefault();
        void (window.cuppet.native as any).openExternal(href).catch(() => undefined);
        return;
      }
      if (filePath && projectId) {
        event.preventDefault();
        void openProjectFile(projectId, filePath, setError);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cuppet-project-file]') : null;
      const path = element?.getAttribute('data-cuppet-project-file');
      if (!path || !projectId) return;
      event.preventDefault();
      void openProjectFile(projectId, path, setError);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('click', handleClick); document.removeEventListener('keydown', handleKey); };
  }, [projectId]);

  useEffect(() => { setOpen(false); setError(''); }, [sessionId]);

  if (!mount || !projectId || !files.length) return null;
  return createPortal(
    <div className={`workspace-edited-files${open ? ' open' : ''}`}>
      <button type="button" className="workspace-edited-files-trigger" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5.25 3.25h5.1l2.4 2.4v9.1h-7.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><path d="M10.25 3.5v2.4h2.35M7 9h4M7 11.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
        <span>{files.length} file{files.length === 1 ? '' : 's'} edited</span>
        <svg className="workspace-edited-files-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open && <div className="workspace-edited-files-list" aria-label="Edited files">
        {files.map((file) => <button type="button" className="workspace-edited-file" key={file.path} title={`Open ${file.path}`} onClick={() => void openProjectFile(projectId, file.path, setError)}>
          <span>{file.path}</span><span className="workspace-edited-file-action">Open</span>
        </button>)}
        {error && <div className="workspace-edited-files-error">{error}</div>}
      </div>}
    </div>,
    mount,
  );
}

async function openProjectFile(projectId: string, path: string, setError: (value: string) => void) {
  setError('');
  try { await (window.cuppet.native as any).openProjectFile(projectId, stripLineSuffix(path)); }
  catch (error) { setError(error instanceof Error ? error.message : String(error)); }
}

function stripLineSuffix(value: string) {
  return String(value).trim().replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
}
