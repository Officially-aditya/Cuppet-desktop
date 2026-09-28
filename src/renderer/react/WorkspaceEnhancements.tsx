import { useCallback, useEffect, useState } from 'react';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';
const CODE_FILE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Cargo\.toml|go\.mod|go\.sum|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kt|kts|swift|css|scss|sass|less|html?|vue|svelte|ya?ml|toml|sql|sh|bash|zsh|fish|c|h|cc|cpp|cxx|hpp|cs|rb|php|xml|gradle|properties|ini|conf|env|graphql|proto))(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

type EditedFileEvent = { path: string; tool?: string; updatedAt?: number };
type EditedFilesResult = { sessionId: string; projectId?: string | null; files?: EditedFileEvent[] };
type RuntimeMessage = { id: string; role?: string; status?: string; sequence?: number; createdAt?: number };

export function WorkspaceEnhancements() {
  const [projectId, setProjectId] = useState<string | null>(null);

  const sync = useCallback(async () => {
    markInlineProjectFiles();
    const id = localStorage.getItem(LAST_SESSION_KEY) || '';
    const hasConversation = Boolean(document.querySelector('.react-messages .message[data-message-id]'));
    if (!id || !hasConversation) {
      setProjectId(null);
      clearTurnFileSummaries();
      return;
    }
    try {
      const [session, edited] = await Promise.all([
        window.cuppet.sessions.get(id),
        (window.cuppet.sessions as any).editedFiles(id) as Promise<EditedFilesResult>,
      ]);
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') !== id) return;
      const nextProjectId = typeof session?.projectId === 'string' ? session.projectId : null;
      setProjectId(nextProjectId);
      syncTurnFileSummaries(
        Array.isArray(session?.messages) ? session.messages as RuntimeMessage[] : [],
        Array.isArray(edited?.files) ? edited.files : [],
        nextProjectId,
      );
      markInlineProjectFiles();
    } catch {
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') === id) {
        setProjectId(null);
        clearTurnFileSummaries();
      }
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
      if (event?.type === 'run.finished') window.setTimeout(requestSync, 60);
      if (event?.type === 'mutation.undone' || event?.type === 'session.restored' || event?.type === 'session.deleted' || event?.type === 'session.purged') requestSync();
      if (event?.type === 'message.preview') queueMicrotask(markInlineProjectFiles);
    });
    return () => {
      observer.disconnect();
      removeEvent();
      clearTurnFileSummaries();
    };
  }, [sync]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const toggle = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-cuppet-edited-files-toggle]') : null;
      if (toggle) {
        const summary = toggle.closest<HTMLElement>('[data-cuppet-edited-files-summary]');
        const list = summary?.querySelector<HTMLElement>('[data-cuppet-edited-files-list]');
        if (!summary || !list) return;
        event.preventDefault();
        const open = !summary.classList.contains('open');
        summary.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
        list.hidden = !open;
        return;
      }

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

function syncTurnFileSummaries(_messages: RuntimeMessage[], _events: EditedFileEvent[], _projectId: string | null) {
  // Replaced by the interactive modified button (.turn-diff-card) in ChatPane.
  clearTurnFileSummaries();
}

function groupEditedFilesByTurn(messages: RuntimeMessage[], events: EditedFileEvent[]) {
  const assistants = messages
    .filter((message) => message?.role === 'assistant' && Number.isFinite(Number(message.createdAt)))
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
  const grouped = new Map<string, Map<string, EditedFileEvent>>();
  for (const event of events) {
    const at = Number(event?.updatedAt);
    const path = normalizeProjectPath(event?.path);
    if (!path || !Number.isFinite(at)) continue;
    let owner: RuntimeMessage | null = null;
    for (const assistant of assistants) {
      if (Number(assistant.createdAt) > at) break;
      owner = assistant;
    }
    if (!owner || owner.status === 'streaming') continue;
    const files = grouped.get(owner.id) ?? new Map<string, EditedFileEvent>();
    files.set(path, { ...event, path });
    grouped.set(owner.id, files);
  }
  return new Map([...grouped].map(([messageId, files]) => [
    messageId,
    [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  ]));
}

function clearTurnFileSummaries() {
  for (const node of document.querySelectorAll('[data-cuppet-edited-files-summary]')) node.remove();
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

function normalizeProjectPath(value: unknown) {
  const path = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('\0')) return '';
  return path.slice(0, 1024);
}

function stripLineSuffix(value: string) {
  return String(value).trim().replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
}

function cssEscape(value: string) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}
