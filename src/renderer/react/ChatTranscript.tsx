import { memo, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { Project, Session } from '../types';
import type { PendingUserMessage } from './client-session-state';
import type { ActivityEntry } from './ChatPane';
import { CopyIcon, CheckIcon, type DiffFile } from './DiffViewerModal';
import { createStreamingMarkdownRenderer, renderMarkdown } from './markdown';
import { createMarkdownCache } from './markdown-cache';
import { createScrollFollower, type ScrollFollower } from './scroll-follow';
import { copyCodeBlock } from './code-copy';
import { isProjectFileTarget, openChatLink } from './project-links';
import { CUPPET_LOGO_URL } from './brand';
import { formatWorkedDuration, orderedTranscriptItems, type TranscriptItem, type TranscriptReasoning, type TranscriptState } from './chat-transcript';

type TraceReasoning = TranscriptReasoning;
type TraceStatus = { id: string; type: 'status'; text: string; sequence: number };
type TraceTool = {
  id: string;
  type: 'tool';
  status: 'running' | 'complete' | 'error';
  tool: string;
  argumentsJson: string;
  label?: string;
  details?: string;
  sequence: number;
};
type TraceItem = TraceReasoning | TraceTool | TraceStatus;
const MAX_VISIBLE_USER_LINES = 10;
const IMMEDIATE_HISTORY_ITEMS = 5;
const EMPTY_TRACE: TraceItem[] = [];
const EMPTY_PENDING: readonly PendingUserMessage[] = [];
const renderMarkdownCached = createMarkdownCache((source) => renderMarkdown(source));
export type ChatTranscriptHandle = { followLatest: () => void };
type Props = {
  ref?: Ref<ChatTranscriptHandle>;
  session: Session | null;
  project: Project | null;
  running: boolean;
  transcript: TranscriptState;
  pending?: readonly PendingUserMessage[];
  onInspectDiff: (files: DiffFile[], rawDiff?: string) => void;
  onOpenLightbox: (image: { src: string; name?: string }) => void;
  onOpenFolder?: () => void;
  onCloneRepository?: () => void;
  onConfigureProvider?: () => void;
};

export function ChatTranscript({ ref, session, project, running, transcript, pending = EMPTY_PENDING, onInspectDiff, onOpenLightbox, onOpenFolder, onCloneRepository, onConfigureProvider }: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<ScrollFollower | null>(null);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    const follower = createScrollFollower(node, session?.id ? `cuppet.desktop.scroll.${session.id}` : null);
    followerRef.current = follower;
    return () => {
      follower.dispose();
      if (followerRef.current === follower) followerRef.current = null;
    };
  }, [session?.id]);

  useEffect(() => {
    followerRef.current?.schedule();
  }, [session?.messages, transcript, running, pending]);

  useImperativeHandle(ref, () => ({
    followLatest() { followerRef.current?.followLatest(); },
  }), []);

  const previousRun = useRef({ sessionId: session?.id, running });
  const [completion, setCompletion] = useState('');
  useEffect(() => {
    const previous = previousRun.current;
    if (previous.sessionId === session?.id && previous.running && !running) {
      const last = [...(session?.messages ?? [])].reverse().find((message) => message.role === 'assistant');
      setCompletion(last?.status === 'error' ? 'Response failed.' : last?.status === 'stopped' ? 'Response stopped.' : 'Response complete.');
    } else if (previous.sessionId !== session?.id || running) setCompletion('');
    previousRun.current = { sessionId: session?.id, running };
  }, [session?.id, session?.messages, running]);

  const messages = session?.messages?.filter((message) => message.role !== 'system') ?? [];
  const lastMessage = messages[messages.length - 1];
  const runningAssistant = running && lastMessage?.role === 'assistant' && lastMessage.status === 'streaming' ? lastMessage : null;
  const stableMessages = runningAssistant ? messages.filter((message) => message.id !== runningAssistant.id) : messages;
  const runningState = runningAssistant ? transcript[runningAssistant.id] : undefined;
  const runningPreview = runningState?.preview ?? '';
  const runningTrace = runningState?.items ?? EMPTY_TRACE;
  const emptyTitle = project?.name ? `Start Working in ${project.name}` : project ? 'Start Working in this project' : 'Start a conversation';
  const emptyDescription = project ? 'Describe what you want to build or change in this project.' : 'Open a project to work with your files, or start chatting below.';


  return (
    <>
      <section ref={messagesRef} className="messages react-messages" role="log" aria-label="Conversation" aria-live="off" aria-busy={running} tabIndex={0}>
        {!messages.length && !pending.length ? (
          <div className="empty-state">
            <img className="empty-logo" src={CUPPET_LOGO_URL} alt="" aria-hidden="true" />
            <h1>{emptyTitle}</h1><p>{emptyDescription}</p>
            {!project && <div className="empty-state-actions">
              <button type="button" className="primary-button" onClick={onOpenFolder}>Open a folder</button>
              <button type="button" className="ghost-button" onClick={onCloneRepository}>Clone a repository</button>
              <button type="button" className="text-button" onClick={onConfigureProvider}>Set up a provider</button>
            </div>}
          </div>
        ) : stableMessages.map((message, index) => (
          <TranscriptMessage key={message.id} message={message} items={transcript[message.id]?.items}
            deferred={index < stableMessages.length - IMMEDIATE_HISTORY_ITEMS}
            onInspectDiff={onInspectDiff} onOpenLightbox={onOpenLightbox} projectId={project?.id ?? session?.projectId ?? null} />
        ))}
        {runningAssistant && (runningPreview || runningAssistant.content || runningTrace.length > 0) && (
          <MessageView key={runningAssistant.id} message={{ ...runningAssistant, content: runningPreview || runningAssistant.content }}
            items={runningTrace} live onInspectDiff={onInspectDiff} onOpenLightbox={onOpenLightbox} projectId={project?.id ?? session?.projectId ?? null} />
        )}
        {pending.map((item) => (
          <MessageView key={item.id} message={{ ...item, role: 'user', status: 'complete' }}
            pendingLabel={item.kind === 'steer' ? 'Adding to the current turn…' : 'Sending…'}
            onOpenLightbox={onOpenLightbox} projectId={project?.id ?? session?.projectId ?? null} />
        ))}
      </section>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{completion}</div>
    </>
  );
}

function TranscriptMessage({ message, items, deferred, onInspectDiff, onOpenLightbox, projectId }: {
  message: Session['messages'][number];
  items?: TranscriptItem[];
  deferred: boolean;
  onInspectDiff: Props['onInspectDiff'];
  onOpenLightbox: Props['onOpenLightbox'];
  projectId: string | null;
}) {
  // Reuse the element so streaming another turn does not render unchanged history.
  const view = useMemo(() => (
    <MessageView message={message} items={items} onInspectDiff={onInspectDiff} onOpenLightbox={onOpenLightbox} projectId={projectId} />
  ), [message, items, onInspectDiff, onOpenLightbox, projectId]);
  const deferredView = useDeferredValue(view, deferred ? null : view);
  return (
    <div className="transcript-message-slot">
      {(deferred ? deferredView : view) ?? (
        <article className={`message ${message.role}`} data-message-id={message.id} aria-busy="true">
          <div className="message-role">{message.role === 'assistant' ? 'Cuppet' : 'You'}</div>
          <div className="message-content">Loading earlier message…</div>
        </article>
      )}
    </div>
  );
}

function MessageView({
  message,
  trace: providedTrace,
  items,
  live = false,
  pendingLabel,
  onInspectDiff,
  onOpenLightbox,
  projectId = null,
}: {
  message: Session['messages'][number];
  trace?: TraceItem[];
  items?: TranscriptItem[];
  live?: boolean;
  pendingLabel?: string;
  onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void;
  onOpenLightbox?: (image: { src: string; name?: string }) => void;
  projectId?: string | null;
}) {
  const trace = useMemo(() => providedTrace ?? traceForItems(items ?? EMPTY_TRACE), [providedTrace, items]);
  const diffTrace = useDeferredValue(trace, EMPTY_TRACE);
  const [traceOpen, setTraceOpen] = useState(live || message.status === 'stopped');
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const startedAtRef = useRef<number>(Number(message.createdAt) || Date.now());
  const prevLiveRef = useRef(live);
  const [copied, setCopied] = useState(false);
  const responseRef = useRef<HTMLDivElement | null>(null);
  const status = message.status && message.status !== 'complete' ? statusLabel(message.status) : null;
  const assistant = message.role === 'assistant';
  const content = String(message.content ?? '');
  const [messageExpanded, setMessageExpanded] = useState(false);
  const userLines = message.role === 'user' ? content.split(/\r\n|\r|\n/) : [];
  const canExpand = userLines.length > MAX_VISIBLE_USER_LINES;
  const visibleContent = canExpand && !messageExpanded ? userLines.slice(0, MAX_VISIBLE_USER_LINES).join('\n') : content;
  const hasTrace = assistant && trace.length > 0;
  const canCopy = !live && message.status !== 'streaming' && Boolean(content.trim());

  useEffect(() => {
    if (prevLiveRef.current && !live) {
      if (message.status !== 'stopped') setTraceOpen(false);
      setCompletedAt(Date.now());
    }
    prevLiveRef.current = live;
  }, [live, message.status]);

  const workedDurationText = useMemo(() => {
    if (live || message.status === 'streaming') return null;
    const start = Number(message.createdAt) || startedAtRef.current;
    const end = (Number(message.updatedAt) && Number(message.updatedAt) >= start)
      ? Number(message.updatedAt)
      : completedAt;
    if (!start || !end || end < start) return null;
    const durationMs = end - start;
    if (durationMs <= 0) return null;
    return `Worked for ${formatWorkedDuration(durationMs)}`;
  }, [live, message.status, message.createdAt, message.updatedAt, completedAt]);

  const { editedFiles, rawDiff } = useMemo(() => {
    if (!assistant) return { editedFiles: [] as DiffFile[], rawDiff: '' };
    const filesMap = new Map<string, DiffFile>();
    let diffAccumulator = '';

    for (const item of diffTrace) {
      if (item.type !== 'tool') continue;
      const normalized = item.tool.toLowerCase();
      const itemDiff = item.details && item.details.includes('--- ') && item.details.includes('+++ ') ? item.details : '';
      const isEdit = normalized === 'tst_edit_batch' ||
                     normalized === 'workspace_edit' ||
                     normalized === 'workspace_write' ||
                     /(^|[_-])(edit|patch|write|diff)($|[_-])/.test(normalized) ||
                     Boolean(itemDiff);
      if (!isEdit) continue;

      const args = parseToolArguments(item.argumentsJson);
      const targets = toolTargets(item.tool, args);
      for (const target of targets) {
        if (!filesMap.has(target)) {
          filesMap.set(target, {
            path: target,
            status: normalized.includes('write') ? 'added' : 'modified',
          });
        }
      }

      const outputText = item.details || '';
      if (itemDiff) {
        diffAccumulator += (diffAccumulator ? '\n' : '') + itemDiff;
        for (const target of targets) {
          const file = filesMap.get(target);
          if (file && !file.diff) file.diff = itemDiff;
        }
      } else if (normalized === 'workspace_edit' || /(^|[_-])edit($|[_-])/.test(normalized)) {
        const p = String(args.path || targets[0] || '');
        const oldText = String(args.old_text ?? args.oldText ?? '');
        const newText = String(args.new_text ?? args.newText ?? '');
        if (p && (oldText || newText)) {
          const oldList = oldText ? oldText.split('\n') : [];
          const newList = newText ? newText.split('\n') : [];
          const oldLines = oldList.map((l) => `-${l}`).join('\n');
          const newLines = newList.map((l) => `+${l}`).join('\n');
          const chunk = `--- a/${p}\n+++ b/${p}\n@@ -1,${oldList.length} +1,${newList.length} @@\n${oldLines}${oldLines && newLines ? '\n' : ''}${newLines}`;
          diffAccumulator += (diffAccumulator ? '\n' : '') + chunk;
          const file = filesMap.get(p);
          if (file) file.diff = chunk;
        }
      } else if (normalized === 'workspace_write' || /(^|[_-])write($|[_-])/.test(normalized)) {
        const p = String(args.path || targets[0] || '');
        const content = String(args.content ?? '');
        if (p) {
          const lines = content.split('\n').map((l) => `+${l}`).join('\n');
          const chunk = `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines}`;
          diffAccumulator += (diffAccumulator ? '\n' : '') + chunk;
          const file = filesMap.get(p);
          if (file) {
            file.diff = chunk;
            file.status = 'added';
          }
        }
      } else if (normalized === 'tst_edit_batch') {
        const operations = Array.isArray(args.operations) ? args.operations : [];
        for (const op of operations) {
          const p = String(op.target?.path || op.path || '');
          const expected = String(op.target?.expected_source || op.expected_source || op.old_text || '');
          const next = String(op.source || op.new_source || op.new_text || '');
          if (p && (expected || next)) {
            const oldList = expected ? expected.split('\n') : [];
            const newList = next ? next.split('\n') : [];
            const oldLines = oldList.map((l) => `-${l}`).join('\n');
            const newLines = newList.map((l) => `+${l}`).join('\n');
            const chunk = `--- a/${p}\n+++ b/${p}\n@@ -1,${oldList.length} +1,${newList.length} @@\n${oldLines}${oldLines && newLines ? '\n' : ''}${newLines}`;
            diffAccumulator += (diffAccumulator ? '\n' : '') + chunk;
            const file = filesMap.get(p);
            if (file && !file.diff) file.diff = chunk;
          }
        }
      }
    }

    return { editedFiles: Array.from(filesMap.values()), rawDiff: diffAccumulator };
  }, [assistant, diffTrace]);

  const copySummary = async () => {
    if (!canCopy) return;
    try {
      const rendered = assistant ? responseRef.current?.innerText?.trim() : '';
      const value = rendered || content.trim();
      if (!value) return;
      await window.cuppet.native.copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`message ${message.role}${live ? ' message-preview' : ''}${pendingLabel ? ' message-pending' : ''}`} data-message-id={message.id} aria-busy={pendingLabel ? true : undefined}>
      <div className="message-role">
        {hasTrace ? (
          <button
            type="button"
            className={`message-cuppet-toggle${traceOpen ? ' open' : ''}`}
            aria-expanded={traceOpen}
            aria-label={traceOpen
              ? (workedDurationText ? `Hide Cuppet activity (${workedDurationText})` : 'Hide Cuppet activity')
              : (workedDurationText ? `Show Cuppet activity (${workedDurationText})` : 'Show Cuppet activity')
            }
            onClick={() => setTraceOpen((current) => !current)}
          >
            <span>Cuppet</span>
            {workedDurationText && <span className="message-worked-time">({workedDurationText})</span>}
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : assistant ? 'Cuppet' : 'You'}
        {pendingLabel && <span className="message-pending-label" role="status">{pendingLabel}</span>}
      </div>
      {hasTrace && traceOpen && <TraceView trace={trace} messageId={message.id} live={live} completedAt={Number(message.updatedAt) || completedAt} onInspectDiff={onInspectDiff} projectId={projectId} />}
      {assistant ? (
        content ? (
          <MarkdownContent
            ref={responseRef}
            className="message-content markdown-rendered"
            content={content}
            streaming={live}
            projectId={projectId}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.tagName === 'IMG') {
                const img = target as HTMLImageElement;
                if (img.src) {
                  onOpenLightbox?.({ src: img.src, name: img.alt || 'Image' });
                }
              }
            }}
          />
        ) : null
      ) : (
        <div className="message-content">
          <span id={`message-text-${message.id}`} className="message-text">{visibleContent}</span>
          {canExpand && (
            <button
              type="button"
              className="message-show-more"
              aria-expanded={messageExpanded}
              aria-controls={`message-text-${message.id}`}
              onClick={() => setMessageExpanded((current) => !current)}
            >
              {messageExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {Array.isArray(message.attachments) && message.attachments.some((attachment) => !attachment.dataUrl) && (
            <div className="message-attachments" role="list" aria-label="Attached files">
              {message.attachments.filter((attachment) => !attachment.dataUrl).map((attachment, index) => (
                <div className="message-attachment" role="listitem" key={index} title={attachment.name}>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M11.5 2.5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4.5-4.5Z M11.5 2.5V7H16 M7 11h6M7 14h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="message-attachment-name">{attachment.name}</span>
                </div>
              ))}
            </div>
          )}
          {Array.isArray(message.attachments) && message.attachments.some((a) => a.dataUrl) && (
            <div className="message-image-gallery">
              {message.attachments
                .filter((a) => a.dataUrl)
                .map((attachment, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="message-image-thumb-btn"
                    title={`View ${attachment.name || 'image'}`}
                    onClick={() => onOpenLightbox?.({ src: attachment.dataUrl!, name: attachment.name })}
                  >
                    <img src={attachment.dataUrl} alt={attachment.name || ''} loading="lazy" />
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
      {editedFiles.length > 0 && (
        <div
          role="button"
          tabIndex={0}
          className="turn-diff-card"
          aria-label={`Inspect ${editedFiles.length} modified ${editedFiles.length === 1 ? 'file' : 'files'}`}
          title="Click to view code changes in split diff viewer"
          onClick={() => onInspectDiff?.(editedFiles, rawDiff)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onInspectDiff?.(editedFiles, rawDiff);
            }
          }}
        >
          <div className="turn-diff-info">
            <svg className="turn-diff-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 4 2 8l3.5 4M10.5 4l3.5 4-3.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <span className="turn-diff-label">
                {editedFiles.length} {editedFiles.length === 1 ? 'file' : 'files'} modified
              </span>
              <span className="turn-diff-files-preview">
                {' · ' + editedFiles.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ') + (editedFiles.length > 3 ? ` +${editedFiles.length - 3}` : '')}
              </span>
            </div>
          </div>
          <span className="turn-diff-chevron" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
              <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      )}
      {status && <div className={`message-status${message.status === 'error' ? ' error' : ''}`}>{status}</div>}
      {canCopy && (
        <div className="message-footer-actions message-footer-copy">
          <button
            type="button"
            className={`message-copy-button${copied ? ' copied' : ''}`}
            aria-label={copied ? 'Copied' : assistant ? 'Copy final response' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={() => void copySummary()}
          >
            <span className="copy-icon-wrapper" aria-hidden="true">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
          </button>
        </div>
      )}
    </article>
  );
}

// projectId is the project a rendered file path or link opens against.
function MarkdownBlock({ html }: { html: string }) {
  return <div className="markdown-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MarkdownContent({ content, streaming = false, projectId = null, onClick, onKeyDown, ...props }: React.ComponentProps<'div'> & { content: string; streaming?: boolean; projectId?: string | null }) {
  const renderStream = useMemo(() => createStreamingMarkdownRenderer(), []);
  // Replacing unchanged HTML destroys the browser's active text selection.
  const rendered = useMemo(() => streaming ? renderStream(content) : { blocks: [], tail: renderMarkdownCached(content) }, [content, streaming, renderStream]);
  const completedBlocks = useMemo(() => rendered.blocks.map((html, index) => <MarkdownBlock key={index} html={html} />), [rendered.blocks]);
  return (
    <div
      {...props}
      onClick={(event) => {
        // Code block copy buttons, links and file paths are marked by renderMarkdown and handled here, declaratively.
        if (copyCodeBlock(event.target)) return;
        if (openChatLink(projectId, event.target)) { event.preventDefault(); return; }
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && isProjectFileTarget(event.target) && openChatLink(projectId, event.target)) { event.preventDefault(); return; }
        onKeyDown?.(event);
      }}
    >
      {completedBlocks}
      <MarkdownBlock key="tail" html={rendered.tail} />
    </div>
  );
}

function TraceView({ trace, messageId, live = false, completedAt, onInspectDiff, projectId = null }: { trace: TraceItem[]; messageId: string; live?: boolean; completedAt?: number | null; onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void; projectId?: string | null }) {
  const ordered = useMemo(() => orderedTrace(trace), [trace]);
  const immediateTools = useMemo(() => new Set(ordered.filter((item) => item.type === 'tool').slice(-IMMEDIATE_HISTORY_ITEMS).map((item) => item.id)), [ordered]);
  return (
    <div className="message-trace thread-activity" aria-label="Cuppet activity">
      {ordered.map((item) => item.type === 'reasoning' ? (
        <ReasoningTraceRow key={item.id} item={item} contentId={`reasoning-${messageId}-${item.id}`} live={live} completedAt={live ? undefined : completedAt} projectId={projectId} />
      ) : item.type === 'status' ? (
        <div key={item.id} className="message-trace-reasoning" role="status">{item.text}</div>
      ) : (
        <ToolTraceRow key={item.id} item={item} deferred={!immediateTools.has(item.id) && item.status !== 'running'} onInspectDiff={onInspectDiff} />
      ))}
    </div>
  );
}

const ReasoningTraceRow = memo(function ReasoningTraceRow({ item, contentId, live, completedAt, projectId = null }: { item: TraceReasoning; contentId: string; live: boolean; completedAt?: number | null; projectId?: string | null }) {
  const [open, setOpen] = useState(false);
  // Commit the toggle before parsing and mounting a potentially long thought.
  const contentReady = useDeferredValue(open);
  const active = live && !item.completedAt;
  const end = item.completedAt ?? (!live ? completedAt : null);
  const duration = item.startedAt && end && end >= item.startedAt ? formatWorkedDuration(end - item.startedAt) : null;
  const commentary = item.kind === 'commentary';
  const label = active
    ? (commentary ? 'Working…' : 'Thinking…')
    : duration ? `${commentary ? 'Worked' : 'Thought'} for ${duration}` : (commentary ? 'Progress' : 'Thoughts');
  return (
    <div className={`message-reasoning${open ? ' open' : ''}`}>
      <button
        type="button"
        className="message-reasoning-toggle"
        aria-expanded={open}
        aria-controls={open && contentReady ? contentId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && contentReady && <MarkdownContent id={contentId} className="message-reasoning-content markdown-rendered" content={item.text} streaming={active} projectId={projectId} />}
    </div>
  );
});

const ToolTraceRow = memo(function ToolTraceRow({ item, onInspectDiff, deferred = false }: { item: TraceTool; onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void; deferred?: boolean }) {
  const [requested, setRequested] = useState(false);
  const view = useMemo(() => <ToolTraceDetails item={item} onInspectDiff={onInspectDiff} initialOpen={requested} />, [item, onInspectDiff, requested]);
  const deferredView = useDeferredValue(view, deferred ? null : view);
  return (!deferred || requested ? view : deferredView) ?? (
    <div className={`thread-tool-row ${item.status}`} aria-busy="true">
      <button type="button" className="thread-tool-summary" aria-expanded={false} onClick={() => setRequested(true)}>
        <div className="thread-tool-label"><span>{humanToolLabel(item.tool)}</span></div>
      </button>
    </div>
  );
});

function ToolTraceDetails({ item, onInspectDiff, initialOpen = false }: { item: TraceTool; onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [copied, setCopied] = useState(false);
  const isFailed = item.status === 'error';
  const args = parseToolArguments(item.argumentsJson);
  const targets = toolTargets(item.tool, args);
  const command = toolCommand(args, false);
  const detail = toolActivityDetail(item.tool, item.argumentsJson, item.details, item.status);
  const rawDiff = item.details && item.details.includes('--- ') && item.details.includes('+++ ') ? item.details : '';
  const isEdit = item.tool === 'tst_edit_batch' ||
                 item.tool === 'workspace_edit' ||
                 item.tool === 'workspace_write' ||
                 /(^|[_-])(edit|patch|write|diff)($|[_-])/.test(item.tool.toLowerCase()) ||
                 Boolean(rawDiff);
  const hasInlineResult = detail.split('\n').some((line) => line.startsWith('Result: '));
  const showCodeBlock = Boolean(item.details) && !isFailed && (!hasInlineResult || Boolean(rawDiff));

  const primaryChip = command
    ? (command.length > 40 ? `${command.slice(0, 38)}…` : command)
    : targets.length > 0
      ? (targets[0].split('/').pop() + (targets.length > 1 ? ` +${targets.length - 1}` : ''))
      : null;

  const copyDetails = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = item.details || item.argumentsJson;
    if (!text) return;
    try {
      await window.cuppet.native.copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`thread-tool-row ${item.status}`}>
      <button type="button" className="thread-tool-summary" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <div className="thread-tool-icon">
          <ToolIcon tool={item.tool} />
        </div>
        <div className="thread-tool-label">
          <span>{humanToolLabel(item.tool)}</span>
          {primaryChip && <span className="thread-tool-chip" title={command || targets.join(', ')}>{primaryChip}</span>}
        </div>
        <span className={`thread-tool-chevron${open ? ' open' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" width="12" height="12"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
      </button>

      {open && (
        <div className="thread-tool-detail">
          {detail && (
            <div className="thread-tool-detail-lines">
              {detail.split('\n').map((line, index) => {
                if (line.startsWith('Result: ')) {
                  return (
                    <div key={`${item.id}:detail:${index}`} className={`thread-tool-result-line${isFailed ? ' error' : ''}`}>
                      <span className="thread-tool-detail-key">Result: </span>
                      <span className="thread-tool-detail-value">{line.slice(8)}</span>
                    </div>
                  );
                }
                const colonIdx = line.indexOf(': ');
                if (colonIdx > 0) {
                  return (
                    <div key={`${item.id}:detail:${index}`}>
                      <span className="thread-tool-detail-key">{line.slice(0, colonIdx + 2)}</span>
                      <span>{line.slice(colonIdx + 2)}</span>
                    </div>
                  );
                }
                return (
                  <div key={`${item.id}:detail:${index}`} className={isFailed ? 'thread-tool-result-line error' : undefined}>
                    {line}
                  </div>
                );
              })}
            </div>
          )}
          {showCodeBlock && (
            <div className="thread-tool-code-block">
              {rawDiff ? (
                item.details?.split('\n').map((line, i) => (
                  <div key={i}>{line}</div>
                ))
              ) : (
                item.details
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              type="button"
              className={`tool-copy-button${copied ? ' copied' : ''}`}
              aria-label={copied ? 'Copied' : 'Copy output'}
              title={copied ? 'Copied' : 'Copy output'}
              onClick={copyDetails}
            >
              <span className="copy-icon-wrapper" aria-hidden="true">
                {copied ? <CheckIcon /> : <CopyIcon />}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolIcon({ tool }: { tool: string }) {
  const normalized = tool.toLowerCase();
  if (normalized === 'bash' || /shell|terminal|command|exec/.test(normalized)) {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="m3 4.5 3.5 3.5L3 11.5M8 11.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (normalized === 'tst_edit_batch' || normalized === 'workspace_edit' || /(^|[_-])(edit|patch)($|[_-])/.test(normalized)) {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="M11 2.5 13.5 5 5 13.5H2.5V11L11 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (normalized === 'tst_read' || normalized === 'workspace_read' || normalized === 'workspace_write' || /(^|[_-])(read|write|file)($|[_-])/.test(normalized)) {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="M3.5 2.5h6l3.5 3.5v7.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M9.5 2.5v3.5h3.5" stroke="currentColor" strokeWidth="1.3"/>
      </svg>
    );
  }
  if (normalized === 'tst_explore' || normalized === 'cuppet_memory_search' || /search|grep|find|explore|glob|locate/.test(normalized)) {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
        <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    );
  }
  if (normalized === 'tst_validate' || /test|verify|validate|lint|check/.test(normalized)) {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="M8 2.5 3 4.5v4.5c0 3 2.5 5.5 5 6 2.5-.5 5-3 5-6V4.5L8 2.5Z" stroke="currentColor" strokeWidth="1.3"/>
        <path d="m6 8 1.5 1.5 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (normalized === 'question') {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5.5l-3 3V3.5Z" stroke="currentColor" strokeWidth="1.3"/>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function traceForItems(items: TranscriptItem[]): TraceItem[] {
  // Preserve item identity so unchanged tool rows keep their state and skip parsing.
  return orderedTranscriptItems(items);
}

function orderedTrace(trace: TraceItem[]) {
  return trace
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.sequence - b.item.sequence || a.index - b.index)
    .map(({ item }) => item);
}

function friendlyActivityLabel(entry: ActivityEntry) {
  return entry.label;
}

function toolActivityLabel(toolName = '', argumentsJson = '{}', status: TraceTool['status']) {
  const args = parseToolArguments(argumentsJson);
  const normalizedTool = toolName.toLowerCase();
  const failed = status === 'error';
  const complete = status === 'complete';
  const phrase = (active: string, done: string, error: string) => failed ? error : complete ? done : active;
  const targets = toolTargets(toolName, args);
  const target = describeTargets(targets, args);
  const focus = toolExploreFocus(args);
  const command = toolCommand(args);

  if (normalizedTool === 'workspace_read' || normalizedTool === 'tst_read' || /(^|[_-])read($|[_-])/.test(normalizedTool)) return target
    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)
    : phrase('Reading file…', 'Read file', 'Couldn’t read file');
  if (normalizedTool === 'tst_explore' || /search|grep|find|explore|locate/.test(normalizedTool)) return focus
    ? phrase(`Searching ${focus}…`, `Searched ${focus}`, `Search failed for ${focus}`)
    : phrase('Searching workspace…', 'Searched workspace', 'Workspace search failed');
  if (normalizedTool === 'tst_edit_batch') {
    if (String(args.action ?? '') === 'apply' && !target) return phrase('Applying edit batch…', 'Applied edit batch', 'Edit batch failed');
    return target ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`) : phrase('Editing files…', 'Edited files', 'Couldn’t edit files');
  }
  if (normalizedTool === 'workspace_edit' || /(^|[_-])(edit|patch)($|[_-])/.test(normalizedTool)) return target
    ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
    : phrase('Editing file…', 'Edited file', 'Couldn’t edit file');
  if (normalizedTool === 'workspace_write' || /(^|[_-])(write|create)($|[_-])/.test(normalizedTool)) return target
    ? phrase(`Writing ${target}…`, `Wrote ${target}`, `Couldn’t write ${target}`)
    : phrase('Writing file…', 'Wrote file', 'Couldn’t write file');
  if (normalizedTool === 'tst_validate' || /test|verify|validate|lint|check/.test(normalizedTool)) return target
    ? phrase(`Validating ${target}…`, `Validated ${target}`, `Validation failed for ${target}`)
    : phrase('Running validation…', `${humanToolLabel(toolName)} passed`, `${humanToolLabel(toolName)} failed`);
  if (normalizedTool === 'cuppet_memory_search') return phrase('Searching memory…', 'Searched memory', 'Memory search failed');
  if (normalizedTool === 'cuppet_plan') return phrase('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (normalizedTool === 'bash' || /shell|terminal|command|exec/.test(normalizedTool)) return command
    ? phrase(`Running ${command}…`, `Ran ${command}`, `Command failed: ${command}`)
    : phrase('Running command…', 'Ran command', 'Command failed');
  if (normalizedTool === 'question') return phrase('Waiting for input…', 'Received input', 'Input request failed');

  const name = humanToolLabel(toolName);
  return phrase(`${name}…`, `${name} completed`, `${name} failed`);
}

function toolActivityDetail(toolName: string, argumentsJson: string, runtimeDetails?: string, status?: string) {
  const args = parseToolArguments(argumentsJson);
  const lines: string[] = [];
  const targets = toolTargets(toolName, args);
  if (targets.length) lines.push(`Target${targets.length === 1 ? '' : 's'}: ${targets.slice(0, 6).join(', ')}${targets.length > 6 ? ` +${targets.length - 6} more` : ''}`);
  const range = toolLineRange(args);
  if (range) lines.push(`Range: ${range}`);
  const query = toolExploreFocus(args);
  if (query && !targets.length) lines.push(`Query: ${query}`);
  const command = toolCommand(args, false);
  if (command) lines.push(`Command: ${command}`);
  const action = typeof args.action === 'string' ? compactActivityText(args.action) : '';
  if (action && !lines.some((line) => line.includes(action))) lines.push(`Action: ${action}`);
  if (runtimeDetails) {
    if (status === 'error') {
      const cleanError = runtimeDetails.trim().replace(/[\r\n\t]+/g, ' ');
      lines.push(`Result: ${cleanError}`);
    } else if (!runtimeDetails.includes('--- ') && !runtimeDetails.includes('+++ ') && runtimeDetails.length <= 160) {
      lines.push(`Result: ${runtimeDetails.trim().replace(/[\r\n\t]+/g, ' ')}`);
    }
  }
  if (!lines.length && toolName) lines.push(`Tool: ${humanToolLabel(toolName)}`);
  return lines.join('\n');
}

function describeTargets(targets: string[], args: Record<string, unknown>) {
  if (!targets.length) return '';
  if (targets.length > 1) {
    const names = targets.slice(0, 3).map(targetName);
    if (targets.length <= 3) return names.join(', ');
    return `${targets.length} files · ${names.slice(0, 2).join(', ')} +${targets.length - 2}`;
  }
  const base = targetName(targets[0]);
  const range = toolLineRange(args);
  return range ? `${base} · ${range}` : base;
}

function toolLineRange(args: Record<string, unknown>) {
  const start = Number(args.start_line ?? args.startLine ?? args.line_start ?? args.offset);
  const end = Number(args.end_line ?? args.endLine ?? args.line_end);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) return `lines ${start}–${end}`;
  if (Number.isFinite(start) && start > 0) return `from line ${start}`;
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0 && (args.path || args.file)) return `up to ${limit} lines`;
  return '';
}

function toolCommand(args: Record<string, unknown>, compact = true) {
  const value = [args.command, args.cmd, args.script].find((item) => (typeof item === 'string' && item.trim()) || (Array.isArray(item) && item.length));
  if (value === undefined) return '';
  const raw = Array.isArray(value) ? value.map(String).join(' ') : String(value);
  const normalized = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!compact) return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
  return normalized.length > 54 ? `${normalized.slice(0, 51)}…` : normalized;
}

function humanToolLabel(value: string) {
  const normalized = String(value || 'tool')
    .replace(/^cuppet[_-]runtime[_-]/, '')
    .replace(/^cuppet[_-]/, '')
    .replace(/^tst[_-]/, 'TST ')
    .replace(/^workspace[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return normalized ? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Tool';
}

function toolTargets(toolName: string, args: Record<string, unknown>) {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (path && !values.includes(path)) values.push(path);
  };

  add(args.path);
  add(args.file);
  add(args.filename);
  add(args.file_path);
  add(args.filePath);
  add(args.filepath);
  add(args.target);
  if (Array.isArray(args.paths)) for (const value of args.paths) add(value);
  if (Array.isArray(args.files)) for (const value of args.files) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);
  if (Array.isArray(args.targets)) for (const value of args.targets) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);

  if (toolName === 'tst_read' || toolName === 'workspace_read') {
    add(args.path);
    for (const item of arrayRecords(args.reads)) add(item.path);
    for (const item of arrayRecords(args.targets)) add(item.path);
  } else if (toolName === 'tst_edit_batch') {
    for (const item of arrayRecords(args.operations)) {
      add(item.path);
      if (item.target && typeof item.target === 'object' && !Array.isArray(item.target)) add((item.target as Record<string, unknown>).path);
    }
  } else if (toolName === 'tst_validate') {
    for (const value of Array.isArray(args.paths) ? args.paths : []) add(value);
  } else if (toolName === 'workspace_edit' || toolName === 'workspace_write') {
    add(args.path);
  }
  return values.slice(0, 64);
}

function toolExploreFocus(args: Record<string, unknown>) {
  const prefix = typeof args.prefix === 'string' ? args.prefix.trim() : '';
  if (prefix) return targetName(prefix);
  const query = [args.query, args.pattern, args.search, args.needle].find((value) => typeof value === 'string' && value.trim());
  if (typeof query === 'string') return compactActivityText(query);
  return '';
}

function parseToolArguments(value: string) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function arrayRecords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
}

function targetName(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.split('/').filter(Boolean).at(-1) || normalized;
  return compactActivityText(name);
}

function compactActivityText(value: string) {
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function statusLabel(status: string) {
  if (status === 'streaming') return null;
  if (status === 'stopped') return 'Stopped';
  if (status === 'interrupted') return 'Interrupted by restart';
  if (status === 'error') return 'Generation failed';
  return status;
}

