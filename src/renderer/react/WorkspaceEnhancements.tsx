import { useCallback, useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';
const TRACE_KEY_PREFIX = 'cuppet.desktop.trace.';
const LEGACY_REASONING_KEY_PREFIX = 'cuppet.desktop.reasoning.';
const CODE_FILE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Cargo\.toml|go\.mod|go\.sum|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kt|kts|swift|css|scss|sass|less|html?|vue|svelte|ya?ml|toml|sql|sh|bash|zsh|fish|c|h|cc|cpp|cxx|hpp|cs|rb|php|xml|gradle|properties|ini|conf|env|graphql|proto))(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

type EditedFileEvent = { path: string; tool?: string; updatedAt?: number };
type EditedFilesResult = { sessionId: string; projectId?: string | null; files?: EditedFileEvent[] };
type RuntimeMessage = { id: string; role?: string; status?: string; sequence?: number; createdAt?: number };
type ReasoningSegment = { id: string; text: string };

export function WorkspaceEnhancements() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const liveReasoning = useRef(new Map<string, ReasoningSegment[]>());
  const activeSession = useRef('');

  const sync = useCallback(async () => {
    markInlineProjectFiles();
    syncVisibleReasoning(liveReasoning.current);
    const id = localStorage.getItem(LAST_SESSION_KEY) || '';
    if (activeSession.current !== id) {
      activeSession.current = id;
      liveReasoning.current.clear();
      clearVisibleReasoning();
    }
    const hasConversation = Boolean(document.querySelector('.react-messages .message[data-message-id]'));
    if (!id || !hasConversation) {
      setProjectId(null);
      clearTurnFileSummaries();
      clearVisibleReasoning();
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
      syncVisibleReasoning(liveReasoning.current);
      markInlineProjectFiles();
    } catch {
      if ((localStorage.getItem(LAST_SESSION_KEY) || '') === id) {
        setProjectId(null);
        clearTurnFileSummaries();
        syncVisibleReasoning(liveReasoning.current);
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
      if (event?.type === 'message.reasoning') {
        const messageId = typeof event?.messageId === 'string' ? event.messageId : '';
        const text = typeof event?.segment === 'string' ? event.segment.trim() : '';
        if (messageId && text) {
          const current = liveReasoning.current.get(messageId) ?? [];
          if (current.at(-1)?.text !== text) {
            liveReasoning.current.set(messageId, [...current, { id: `live-${Date.now()}-${current.length}`, text }]);
          }
          syncVisibleReasoning(liveReasoning.current);
          window.setTimeout(requestSync, 0);
        }
        return;
      }
      if (event?.type === 'run.finished') window.setTimeout(requestSync, 60);
      if (event?.type === 'mutation.undone' || event?.type === 'session.restored' || event?.type === 'session.deleted' || event?.type === 'session.purged') requestSync();
      if (event?.type === 'message.preview') queueMicrotask(() => { markInlineProjectFiles(); syncVisibleReasoning(liveReasoning.current); });
    });
    return () => {
      observer.disconnect();
      removeEvent();
      clearTurnFileSummaries();
      clearVisibleReasoning();
      liveReasoning.current.clear();
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

function syncVisibleReasoning(liveReasoning: Map<string, ReasoningSegment[]>) {
  const desired = new Set<string>();
  const articles = document.querySelectorAll<HTMLElement>('.message.assistant[data-message-id]');
  for (const article of articles) {
    const messageId = article.getAttribute('data-message-id') || '';
    if (!messageId) continue;
    const stored = readStoredReasoning(messageId);
    const live = liveReasoning.get(messageId) ?? [];
    const segments = mergeReasoning(stored, live);
    const current = article.querySelector<HTMLElement>(':scope > [data-cuppet-visible-reasoning]');
    if (!segments.length) {
      current?.remove();
      continue;
    }
    desired.add(messageId);
    const signature = segments.map((item) => item.text).join('\n\u001e\n');
    let node = current;
    if (!node) {
      node = document.createElement('div');
      node.className = 'message-content markdown-rendered message-visible-reasoning';
      node.setAttribute('data-cuppet-visible-reasoning', 'true');
      node.setAttribute('data-message-id', messageId);
    }
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature;
      node.innerHTML = segments.map((item) => `<div class="message-visible-reasoning-segment" data-reasoning-id="${escapeAttribute(item.id)}">${renderMarkdown(item.text)}</div>`).join('');
    }
    const anchor = article.querySelector<HTMLElement>(':scope > .message-trace, :scope > .message-content:not([data-cuppet-visible-reasoning]), :scope > .message-status, :scope > .message-edited-files, :scope > .message-footer-actions');
    if (anchor) {
      if (node.parentElement !== article || node.nextElementSibling !== anchor) article.insertBefore(node, anchor);
    } else if (node.parentElement !== article) {
      article.append(node);
    }
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-cuppet-visible-reasoning]')) {
    const messageId = node.getAttribute('data-message-id') || '';
    if (!desired.has(messageId) || !node.closest('.message.assistant')) node.remove();
  }
}

function readStoredReasoning(messageId: string): ReasoningSegment[] {
  try {
    const raw = localStorage.getItem(`${TRACE_KEY_PREFIX}${messageId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.flatMap((item, index) => {
        if (!item || item.type !== 'reasoning' || typeof item.text !== 'string' || !item.text.trim()) return [];
        return [{ id: typeof item.id === 'string' ? item.id : `stored-${index}`, text: item.text.trim() }];
      });
    }
    const legacy = localStorage.getItem(`${LEGACY_REASONING_KEY_PREFIX}${messageId}`)?.trim();
    return legacy ? [{ id: 'legacy-reasoning', text: legacy }] : [];
  } catch {
    return [];
  }
}

function mergeReasoning(stored: ReasoningSegment[], live: ReasoningSegment[]) {
  const output: ReasoningSegment[] = [];
  for (const item of [...stored, ...live]) {
    const text = String(item?.text ?? '').trim();
    if (!text || output.some((existing) => existing.text === text)) continue;
    output.push({ id: String(item?.id ?? `reason-${output.length}`), text });
  }
  return output;
}

function syncTurnFileSummaries(messages: RuntimeMessage[], events: EditedFileEvent[], projectId: string | null) {
  const grouped = groupEditedFilesByTurn(messages, events);
  const desired = new Set(grouped.keys());
  for (const node of document.querySelectorAll<HTMLElement>('[data-cuppet-edited-files-summary]')) {
    const messageId = node.getAttribute('data-message-id') || '';
    if (!desired.has(messageId) || !projectId) node.remove();
  }
  if (!projectId) return;

  for (const [messageId, files] of grouped) {
    const article = document.querySelector<HTMLElement>(`.message.assistant[data-message-id="${cssEscape(messageId)}"]`);
    if (!article || article.classList.contains('message-preview')) continue;
    const signature = files.map((file) => file.path).join('\n');
    const current = article.querySelector<HTMLElement>(':scope > [data-cuppet-edited-files-summary]');
    if (current?.dataset.signature === signature) continue;
    current?.remove();
    const summary = buildTurnFileSummary(messageId, files);
    const footer = article.querySelector(':scope > .message-footer-actions');
    article.insertBefore(summary, footer ?? null);
  }
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

function buildTurnFileSummary(messageId: string, files: EditedFileEvent[]) {
  const summary = document.createElement('div');
  summary.className = 'message-edited-files';
  summary.setAttribute('data-cuppet-edited-files-summary', 'true');
  summary.setAttribute('data-message-id', messageId);
  summary.dataset.signature = files.map((file) => file.path).join('\n');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'message-edited-files-trigger';
  trigger.setAttribute('data-cuppet-edited-files-toggle', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.textContent = `${files.length} file${files.length === 1 ? '' : 's'} edited`;
  const chevron = document.createElement('span');
  chevron.className = 'message-edited-files-chevron';
  chevron.textContent = '⌄';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(chevron);

  const list = document.createElement('div');
  list.className = 'message-edited-files-list';
  list.setAttribute('data-cuppet-edited-files-list', 'true');
  list.setAttribute('aria-label', 'Edited files');
  list.hidden = true;
  for (const file of files) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-edited-file';
    button.setAttribute('data-cuppet-project-file', file.path);
    button.title = `Open ${file.path}`;
    const path = document.createElement('span');
    path.textContent = file.path;
    const action = document.createElement('span');
    action.className = 'message-edited-file-action';
    action.textContent = 'Open';
    button.append(path, action);
    list.append(button);
  }
  summary.append(trigger, list);
  return summary;
}

function clearTurnFileSummaries() {
  for (const node of document.querySelectorAll('[data-cuppet-edited-files-summary]')) node.remove();
}

function clearVisibleReasoning() {
  for (const node of document.querySelectorAll('[data-cuppet-visible-reasoning]')) node.remove();
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

function escapeAttribute(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
