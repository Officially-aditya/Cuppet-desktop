import { useCallback, useEffect, useState } from 'react';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';
const CODE_FILE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Cargo\.toml|go\.mod|go\.sum|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kt|kts|swift|css|scss|sass|less|html?|vue|svelte|ya?ml|toml|sql|sh|bash|zsh|fish|c|h|cc|cpp|cxx|hpp|cs|rb|php|xml|gradle|properties|ini|conf|env|graphql|proto))(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

export function WorkspaceEnhancements() {
  const [projectId, setProjectId] = useState<string | null>(null);

  const sync = useCallback(async () => {
    markInlineProjectFiles();
    const id = localStorage.getItem(LAST_SESSION_KEY) || '';
    const hasConversation = Boolean(document.querySelector('.react-messages .message[data-message-id]'));
    if (!id || !hasConversation) {
      setProjectId(null);
      return;
    }
    try {
      const session = await window.cuppet.sessions.get(id);
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== id) return;
      setProjectId(typeof session?.projectId === 'string' ? session.projectId : null);
    } catch {
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') === id) setProjectId(null);
    }
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
      if (event?.type === 'run.finished' || event?.type === 'session.restored' || event?.type === 'session.deleted' || event?.type === 'session.purged') requestSync();
      if (event?.type === 'message.preview') queueMicrotask(markInlineProjectFiles);
    });
    return () => { observer.disconnect(); removeEvent(); };
  }, [sync]);

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
        void (window.cuppet.native as any).openProjectFile(projectId, stripLineSuffix(filePath)).catch(() => undefined);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cuppet-project-file]') : null;
      const path = element?.getAttribute('data-cuppet-project-file');
      if (!path || !projectId) return;
      event.preventDefault();
      void (window.cuppet.native as any).openProjectFile(projectId, stripLineSuffix(path)).catch(() => undefined);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('click', handleClick); document.removeEventListener('keydown', handleKey); };
  }, [projectId]);

  return null;
}

function markInlineProjectFiles() {
  const nodes = document.querySelectorAll<HTMLElement>('.message.assistant .markdown-rendered :not(pre) > code:not([data-cuppet-project-file])');
  for (const node of nodes) {
    const path = inlineProjectPath(node.textContent);
    if (!path) continue;
    node.setAttribute('data-cuppet-project-file', path);
    node.setAttribute('role', 'link');
    node.tabIndex = 0;
    node.title = `Open ${stripLineSuffix(path)}`;
  }
}

function inlineProjectPath(value: string | null) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 1024 || /\s|:\/\/|[|;&<>`$]/.test(raw)) return '';
  const path = raw.replace(/^[/\\]+/, '').replace(/^\.\//, '').replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || path.includes('/../') || !CODE_FILE.test(path)) return '';
  return path;
}

function stripLineSuffix(value: string) {
  return String(value).trim().replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
}
