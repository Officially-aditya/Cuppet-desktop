import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, CommandDefinition, CommandResult, Project, Session } from '../types';
import { ModelPicker } from './ModelPicker';
import { ProjectTerminal } from './ProjectTerminal';
import { DiffViewerModal, type DiffFile } from './DiffViewerModal';
import { renderMarkdown } from './markdown';
import { CUPPET_LOGO_URL } from './brand';
import {
  GENERAL_SETTINGS_EVENT,
  readPermissionMode,
  readSendBehavior,
} from './behavior-preferences';
import { orderedTranscriptItems, type TranscriptState } from './chat-transcript';
import { useClientTranscript } from './client-transcript';

export type DeliveryMode = 'queue' | 'steer';
export type ComposerMode = 'build' | 'plan' | 'orchestrate';
export type ActivityEntry = {
  id: string;
  kind: 'tool' | 'queue' | 'validation' | string;
  status: 'running' | 'complete' | 'error' | 'queued' | string;
  label: string;
  details?: string;
};

type TraceReasoning = { id: string; type: 'reasoning'; text: string; sequence: number };
type TraceTool = {
  id: string;
  type: 'tool';
  status: 'running' | 'complete' | 'error';
  tool: string;
  argumentsJson: string;
  label: string;
  details?: string;
  sequence: number;
};
type TraceItem = TraceReasoning | TraceTool;
type Draft = { projectId: string | null; mode: 'plan' | 'build' } | null;
const BROWSERCONTROL_MENTION = '@browserControl';

type Props = {
  session: Session | null;
  draft: Draft;
  project: Project | null;
  mode: 'plan' | 'build';
  activeMode: ComposerMode;
  running: boolean;
  commands: CommandDefinition[];
  activity: ActivityEntry[];
  terminalOpen?: boolean;
  onTerminalOpenChange?: (open: boolean) => void;
  onSend: (text: string, deliveryMode: DeliveryMode, attachments: Attachment[]) => Promise<{ clear: boolean; commandResult?: CommandResult }>;
  onStop: () => void | Promise<void>;
  onModeChange: (mode: ComposerMode) => void | Promise<void>;
};

export function ChatPane({ session, draft, project, mode, activeMode, running, commands, activity: _activity, terminalOpen, onTerminalOpenChange, onSend, onStop, onModeChange }: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selected, setSelected] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(() => readSendBehavior());
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [diffModal, setDiffModal] = useState<{ files: DiffFile[]; rawDiff?: string } | null>(null);
  const transcript = useClientTranscript(session);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const palette = useMemo(() => {
    const query = currentSlashQuery(value);
    if (query === null) return [];
    return commands.filter((item) => {
      if (item.paletteOnly) return !query || [item.title, item.description, item.id].filter(Boolean).join(' ').toLowerCase().includes(query);
      return !query || [item.slash, item.title, item.description, ...(item.aliases ?? [])].filter(Boolean).join(' ').toLowerCase().includes(query);
    }).slice(0, 16);
  }, [commands, value]);
  const integrationMentionQuery = currentIntegrationMentionQuery(value);
  const browserControlMentioned = hasBrowserControlMention(value);

  useEffect(() => setSelected(0), [value]);

  useEffect(() => {
    resize(textarea.current);
  }, [value]);

  useEffect(() => {
    setAttachments([]);
    if (fileInput.current) fileInput.current.value = '';
  }, [session?.id, draft?.projectId]);

  useEffect(() => {
    void applyPermissionPreference(session);
  }, [session?.id, session?.projectId]);

  useEffect(() => {
    const sync = () => {
      setDeliveryMode(readSendBehavior());
      void applyPermissionPreference(session);
    };
    window.addEventListener(GENERAL_SETTINGS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(GENERAL_SETTINGS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [session?.id, session?.projectId]);

  useEffect(() => {
    if (running) setDeliveryMode(readSendBehavior());
  }, [running]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    const key = session?.id ? `cuppet.desktop.scroll.${session.id}` : null;
    if (!key) {
      node.scrollTop = node.scrollHeight;
      return;
    }
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) node.scrollTop = saved;
    else node.scrollTop = node.scrollHeight;
    const onScroll = () => localStorage.setItem(key, String(Math.max(0, Math.round(node.scrollTop))));
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [session?.id]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.clientHeight - node.scrollTop;
    if (distance < 100) requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
  }, [session?.messages, transcript]);

  const clearComposer = () => {
    setValue('');
    setAttachments([]);
    if (fileInput.current) fileInput.current.value = '';
    if (textarea.current) textarea.current.style.height = '54px';
    textarea.current?.focus();
  };

  const submit = async () => {
    const raw = value.trim();
    if (!raw && !attachments.length) return;
    // The runtime owns queueing so queued work survives renderer reloads and there is
    // only one authority for ordering, capacity, dispatch, and failure semantics.
    const result = await onSend(raw, deliveryMode, attachments);
    if (result.commandResult) setCommandResult(result.commandResult);
    if (result.clear) clearComposer();
  };

  const addFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    if (!files.length) return;
    setAttachments((current) => {
      const next = [...current];
      const seen = new Set(next.map(attachmentKey));
      for (const file of files) {
        if (next.length >= 16) break;
        const attachment: Attachment = {
          name: file.name,
          ...(file.type ? { mime: file.type } : {}),
          size: file.size,
        };
        const key = attachmentKey(attachment);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(attachment);
      }
      return next;
    });
    event.currentTarget.value = '';
  };

  const choose = async (item: CommandDefinition) => {
    if (item.paletteOnly) {
      const result = await executePaletteAction(item, session?.id ?? null, mode);
      if (result) setCommandResult(result);
      setValue('');
      textarea.current?.focus();
      return;
    }
    if (!item.slash) return;
    setValue(`/${item.slash}${item.takesText ? ' ' : ''}`);
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
      resize(node);
    });
  };

  const chooseBrowserControl = () => {
    setValue((current) => insertBrowserControlMention(current));
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
      resize(node);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (integrationMentionQuery !== null && browserControlMentionMatches(integrationMentionQuery)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setValue((current) => current.replace(/@[^\s]*$/, ''));
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !hasBrowserControlMention(value)) {
        event.preventDefault();
        chooseBrowserControl();
        return;
      }
    }
    if (palette.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((current) => (current + 1) % palette.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((current) => (current - 1 + palette.length) % palette.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setValue(value.includes(' ') ? value : '');
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        const item = palette[selected];
        const exact = item?.slash ? exactSlash(value, item) : false;
        if (item && !exact) {
          event.preventDefault();
          void choose(item);
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const messages = session?.messages?.filter((message) => message.role !== 'system') ?? [];
  const runningAssistant = running ? [...messages].reverse().find((message) => message.role === 'assistant') ?? null : null;
  const stableMessages = runningAssistant ? messages.filter((message) => message.id !== runningAssistant.id) : messages;
  const runningState = runningAssistant ? transcript[runningAssistant.id] : undefined;
  const runningPreview = runningState?.preview ?? '';
  const runningTrace = runningAssistant ? traceForMessage(transcript, runningAssistant.id) : [];
  const emptyTitle = project ? 'Start working in this project' : 'Start a conversation';
  const emptyDescription = project ? 'Cuppet can read and work with this project once you send a message.' : 'General chats are not attached to a filesystem project.';

  return (
    <main className="main-pane react-main-pane">
      <section ref={messagesRef} className="messages react-messages" aria-live="polite" tabIndex={0}>
        {!messages.length ? (
          <div className="empty-state"><img className="empty-logo" src={CUPPET_LOGO_URL} alt="" aria-hidden="true" /><h1>{emptyTitle}</h1><p>{emptyDescription}</p></div>
        ) : stableMessages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            trace={traceForMessage(transcript, message.id)}
            onInspectDiff={(files, rawDiff) => setDiffModal({ files, rawDiff })}
          />
        ))}
        {runningAssistant && (runningPreview || runningAssistant.content || runningTrace.length > 0) && (
          <MessageView
            key={runningAssistant.id}
            message={{ ...runningAssistant, content: runningPreview || runningAssistant.content }}
            trace={runningTrace}
            live
            onInspectDiff={(files, rawDiff) => setDiffModal({ files, rawDiff })}
          />
        )}
      </section>

      <footer className="composer-wrap react-composer-wrap">
        {commandResult && <CommandResultView result={commandResult} onDismiss={() => setCommandResult(null)} />}
        {integrationMentionQuery !== null && browserControlMentionMatches(integrationMentionQuery) && !hasBrowserControlMention(value) && <IntegrationMentionPalette onChoose={chooseBrowserControl} />}
        {palette.length > 0 && <CommandPalette items={palette} selected={selected} sessionAvailable={Boolean(session)} onChoose={choose} />}
        <form className="composer react-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input ref={fileInput} className="composer-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={addFiles} />
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            placeholder="Message Cuppet…"
            autoComplete="off"
            onChange={(event) => { setValue(event.target.value); resize(event.target); }}
            onKeyDown={onKeyDown}
          />
          {browserControlMentioned && (
            <div className="composer-integration-chips" aria-label="Active integrations">
              <button type="button" className="composer-integration-chip" title="Remove browserControl" onClick={() => setValue((current) => removeBrowserControlMention(current))}>
                <span>{BROWSERCONTROL_MENTION}</span><span aria-hidden="true">×</span>
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="Attached files">
              {attachments.map((attachment, index) => (
                <div className="composer-attachment" key={`${attachmentKey(attachment)}:${index}`}>
                  <span title={attachment.name}>{attachment.name}</span>
                  <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-actions react-composer-actions">
            <button type="button" className="composer-attach-button" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            <select
              className="composer-mode-select"
              aria-label="Mode"
              title="Mode"
              value={activeMode}
              onChange={(event) => void onModeChange(event.currentTarget.value as ComposerMode)}
            >
              <option value="build">Build</option>
              <option value="plan">Plan</option>
              <option value="orchestrate">Orchestrate</option>
            </select>
            <div className="composer-actions-spacer" aria-hidden="true" />
            <ModelPicker disabled={running} />
            {running ? (
              <button type="button" className="send-button composer-pause-button" aria-label="Pause" title="Pause" onClick={() => void onStop()}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M7.25 6v8M12.75 6v8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
              </button>
            ) : (
              <button type="submit" className="send-button" aria-label="Send" title="Send" disabled={!value.trim() && !attachments.length}>
                <svg className="send-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 15V5M6.5 8.5 10 5l3.5 3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </footer>
      <ProjectTerminal project={project} open={terminalOpen} onOpenChange={onTerminalOpenChange} />
      {diffModal && (
        <DiffViewerModal
          files={diffModal.files}
          rawDiff={diffModal.rawDiff}
          projectId={project?.id}
          onClose={() => setDiffModal(null)}
        />
      )}
    </main>
  );
}

function MessageView({
  message,
  trace = [],
  live = false,
  onInspectDiff,
}: {
  message: Session['messages'][number];
  trace?: TraceItem[];
  live?: boolean;
  onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void;
}) {
  const [traceOpen, setTraceOpen] = useState(live);
  const [copied, setCopied] = useState(false);
  const responseRef = useRef<HTMLDivElement | null>(null);
  const status = message.status && message.status !== 'complete' ? statusLabel(message.status) : null;
  const assistant = message.role === 'assistant';
  const content = String(message.content ?? '');
  const hasTrace = assistant && trace.length > 0;
  const canCopy = !live && message.status !== 'streaming' && Boolean(content.trim());

  const { editedFiles, rawDiff } = useMemo(() => {
    if (!assistant) return { editedFiles: [] as DiffFile[], rawDiff: '' };
    const filesMap = new Map<string, DiffFile>();
    let diffAccumulator = '';

    for (const item of trace) {
      if (item.type !== 'tool') continue;
      const normalized = item.tool.toLowerCase();
      const isEdit = normalized === 'tst_edit_batch' || normalized === 'workspace_edit' || normalized === 'workspace_write';
      if (!isEdit) continue;

      const args = parseToolArguments(item.argumentsJson);
      const targets = toolTargets(item.tool, args);
      for (const target of targets) {
        if (!filesMap.has(target)) {
          filesMap.set(target, {
            path: target,
            status: normalized === 'workspace_write' ? 'added' : 'modified',
          });
        }
      }

      const outputText = item.details || '';
      if (outputText.includes('--- ') && outputText.includes('+++ ')) {
        diffAccumulator += (diffAccumulator ? '\n' : '') + outputText;
      } else if (normalized === 'workspace_edit') {
        const p = String(args.path || targets[0] || '');
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (p && (oldText || newText)) {
          const oldLines = oldText ? oldText.split('\n').map((l) => `-${l}`).join('\n') : '';
          const newLines = newText ? newText.split('\n').map((l) => `+${l}`).join('\n') : '';
          const chunk = `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n${oldLines}${oldLines && newLines ? '\n' : ''}${newLines}`;
          diffAccumulator += (diffAccumulator ? '\n' : '') + chunk;
          const file = filesMap.get(p);
          if (file) file.diff = chunk;
        }
      } else if (normalized === 'workspace_write') {
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
            const oldLines = expected ? expected.split('\n').map((l) => `-${l}`).join('\n') : '';
            const newLines = next ? next.split('\n').map((l) => `+${l}`).join('\n') : '';
            const chunk = `--- a/${p}\n+++ b/${p}\n@@ ${op.op || 'edit'} @@\n${oldLines}${oldLines && newLines ? '\n' : ''}${newLines}`;
            diffAccumulator += (diffAccumulator ? '\n' : '') + chunk;
            const file = filesMap.get(p);
            if (file && !file.diff) file.diff = chunk;
          }
        }
      }
    }

    return { editedFiles: Array.from(filesMap.values()), rawDiff: diffAccumulator };
  }, [assistant, trace]);

  useEffect(() => {
    if (!live) setTraceOpen(false);
  }, [live]);

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
    <article className={`message ${message.role}${live ? ' message-preview' : ''}`} data-message-id={message.id}>
      <div className="message-role">
        {hasTrace ? (
          <button
            type="button"
            className={`message-cuppet-toggle${traceOpen ? ' open' : ''}`}
            aria-expanded={traceOpen}
            aria-label={traceOpen ? 'Hide Cuppet activity' : 'Show Cuppet activity'}
            onClick={() => setTraceOpen((current) => !current)}
          >
            <span>Cuppet</span>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : assistant ? 'Cuppet' : 'You'}
      </div>
      {hasTrace && traceOpen && <TraceView trace={trace} onInspectDiff={onInspectDiff} />}
      {assistant ? (
        content ? <div ref={responseRef} className="message-content markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} /> : null
      ) : (
        <div className="message-content">{content}</div>
      )}
      {editedFiles.length > 0 && !live && (
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
          <button type="button" className="message-copy-button" aria-label={copied ? 'Copied' : assistant ? 'Copy final response' : 'Copy message'} title={copied ? 'Copied' : 'Copy'} onClick={() => void copySummary()}>
            <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="6.1" y="5.7" width="7" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.25"/><path d="M4.6 11.7H4a1.4 1.4 0 0 1-1.4-1.4V4A1.4 1.4 0 0 1 4 2.6h6.1A1.4 1.4 0 0 1 11.5 4v.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          </button>
        </div>
      )}
    </article>
  );
}

function TraceView({ trace, onInspectDiff }: { trace: TraceItem[]; onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void }) {
  const ordered = orderedTrace(trace);
  return (
    <div className="message-trace thread-activity" aria-label="Cuppet activity">
      {ordered.map((item) => item.type === 'reasoning' ? (
        <div key={item.id} className="message-trace-reasoning markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
      ) : (
        <ToolTraceRow key={item.id} item={item} onInspectDiff={onInspectDiff} />
      ))}
    </div>
  );
}

function ToolTraceRow({ item, onInspectDiff }: { item: TraceTool; onInspectDiff?: (files: DiffFile[], rawDiff?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const args = parseToolArguments(item.argumentsJson);
  const targets = toolTargets(item.tool, args);
  const command = toolCommand(args, false);
  const detail = toolActivityDetail(item.tool, item.argumentsJson, item.details);
  const rawDiff = item.details && item.details.includes('--- ') && item.details.includes('+++ ') ? item.details : '';
  const isEdit = item.tool === 'tst_edit_batch' || item.tool === 'workspace_edit' || item.tool === 'workspace_write';

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
        <span className={`thread-tool-badge ${item.status}`}>
          {item.status === 'running' ? 'Running' : item.status === 'error' ? 'Failed' : 'Done'}
        </span>
        <span className={`thread-tool-chevron${open ? ' open' : ''}`} aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" width="12" height="12"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
      </button>

      {open && (
        <div className="thread-tool-detail">
          {detail && <div>{detail.split('\n').map((line, index) => <div key={`${item.id}:detail:${index}`}>{line}</div>)}</div>}
          {item.details && (
            <div className="thread-tool-code-block">
              {item.details}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            {isEdit && onInspectDiff && (
              <button
                type="button"
                className="turn-diff-inspect-btn"
                onClick={() => {
                  const files: DiffFile[] = targets.map((p) => ({ path: p, status: 'modified' }));
                  onInspectDiff(files, rawDiff);
                }}
              >
                Inspect diff
              </button>
            )}
            <button
              type="button"
              className="diff-action-button"
              style={{ fontSize: '10.5px', padding: '3px 8px' }}
              onClick={copyDetails}
            >
              {copied ? 'Copied' : 'Copy output'}
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
  if (normalized === 'tst_read' || normalized === 'workspace_read' || normalized === 'workspace_write') {
    return (
      <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
        <path d="M3.5 2.5h6l3.5 3.5v7.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3"/>
        <path d="M9.5 2.5v3.5h3.5" stroke="currentColor" strokeWidth="1.3"/>
      </svg>
    );
  }
  if (normalized === 'tst_explore' || normalized === 'cuppet_memory_search' || /search|grep|find|explore/.test(normalized)) {
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

function traceForMessage(state: TranscriptState, messageId: string): TraceItem[] {
  const items = orderedTranscriptItems(state[messageId]?.items ?? []);
  return items.map((item) => item.type === 'reasoning'
    ? { id: item.id, type: 'reasoning', text: item.text, sequence: item.sequence }
    : {
        id: item.id,
        type: 'tool',
        status: item.status,
        tool: item.tool,
        argumentsJson: item.argumentsJson,
        label: toolActivityLabel(item.tool, item.argumentsJson, item.status),
        sequence: item.sequence,
        ...(item.details ? { details: item.details } : {}),
      });
}

function IntegrationMentionPalette({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="command-palette react-command-palette integration-mention-palette" role="listbox" aria-label="Cuppet integrations">
      <button type="button" className="command-option selected" role="option" aria-selected="true" onMouseDown={(event) => event.preventDefault()} onClick={onChoose}>
        <div className="command-name">{BROWSERCONTROL_MENTION}</div>
        <div className="command-description">Use your connected Chrome through browserControl for this turn.</div>
        <div className="command-meta">integration · explicit per-turn access</div>
      </button>
    </div>
  );
}

function CommandPalette({ items, selected, sessionAvailable, onChoose }: { items: CommandDefinition[]; selected: number; sessionAvailable: boolean; onChoose: (item: CommandDefinition) => void | Promise<void> }) {
  return (
    <div className="command-palette react-command-palette" role="listbox" aria-label="Cuppet commands">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={`command-option${index === selected ? ' selected' : ''}`}
          role="option"
          aria-selected={index === selected}
          disabled={Boolean(item.requiresSession && !sessionAvailable && item.paletteOnly)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void onChoose(item)}
        >
          <div className="command-name">{item.slash ? `/${item.slash}` : item.title || item.id}</div>
          <div className="command-description">{item.description}</div>
          <div className="command-meta">{item.paletteOnly ? 'action' : item.requiresSession ? 'session' : 'global'}{item.aliases?.length ? ` · aliases: ${item.aliases.map((alias) => `/${alias}`).join(', ')}` : ''}</div>
        </button>
      ))}
    </div>
  );
}

function CommandResultView({ result, onDismiss }: { result: CommandResult; onDismiss: () => void }) {
  const text = result.presentation || summarize(result.result);
  return (
    <div className="command-result react-command-result" role="status">
      <strong>{result.slash || result.id || 'Command'}</strong>
      <span>{text}</span>
      <button type="button" className="text-button" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

async function executePaletteAction(item: CommandDefinition, sessionId: string | null, mode: 'plan' | 'build') {
  if (item.requiresSession && !sessionId) throw new Error('Start or open a chat before using this action.');
  let input: Record<string, unknown> = {};
  if (item.id === 'cuppet.memory.remember') {
    const key = window.prompt('Memory key')?.trim();
    if (!key) return null;
    const value = window.prompt('What should Cuppet remember?')?.trim();
    if (!value) return null;
    input = { key, value, scope: 'project' };
  } else if (item.id === 'cuppet.memory.forget') {
    const key = window.prompt('Memory key to forget')?.trim();
    if (!key) return null;
    input = { key };
  } else if (item.id === 'cuppet.memory.clear') {
    const scope = (window.prompt('Clear memory scope: session, project, or global', 'session') || '').trim();
    if (!['session', 'project', 'global'].includes(scope)) return null;
    if (!window.confirm(`Clear ${scope} memory?`)) return null;
    input = { scope };
  } else if (item.id === 'cuppet.steer.interrupt') {
    const text = window.prompt('Steer instruction')?.trim();
    if (!text) return null;
    input = { text };
  } else if (item.id === 'cuppet.plan.agent') {
    const next = (window.prompt('Mode: plan or build', mode) || '').trim();
    if (!['plan', 'build'].includes(next)) return null;
    input = { mode: next };
  }
  return window.cuppet.commands.execute(sessionId, { id: item.id, input });
}

function currentIntegrationMentionQuery(value: string) {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1].toLowerCase() : null;
}
function browserControlMentionMatches(query: string) {
  return !query || 'browsercontrol'.startsWith(query) || 'chrome'.startsWith(query);
}
function hasBrowserControlMention(value: string) {
  return /(^|\s)@browsercontrol(?=$|\s|[.,!?;:])/i.test(value);
}
function insertBrowserControlMention(value: string) {
  if (hasBrowserControlMention(value)) return value;
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) return `${value}${value && !/\s$/.test(value) ? ' ' : ''}${BROWSERCONTROL_MENTION} `;
  const prefix = value.slice(0, match.index);
  const spacer = match[0].startsWith(' ') || match[0].startsWith('\n') || !prefix ? match[0].slice(0, 1) : ' ';
  return `${prefix}${spacer}${BROWSERCONTROL_MENTION} `;
}
function removeBrowserControlMention(value: string) {
  return value.replace(/(^|\s)@browsercontrol(?=$|\s|[.,!?;:])/ig, '$1').replace(/[ \t]{2,}/g, ' ').trimStart();
}

function currentSlashQuery(value: string) {
  if (!value.startsWith('/') || value.includes('\n')) return null;
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) return null;
  return value.slice(1).toLowerCase();
}

function exactSlash(value: string, item: CommandDefinition) {
  const trimmed = value.trim().toLowerCase();
  return trimmed === `/${item.slash}` || item.aliases?.some((alias) => trimmed === `/${alias}`);
}

function attachmentKey(value: Attachment) {
  return `${value.name}:${value.size ?? ''}:${value.mime ?? ''}`;
}

async function applyPermissionPreference(session: Session | null) {
  if (!session?.id) return;
  const preference = readPermissionMode();
  const effective: boolean | 'full' = session.projectId
    ? preference === 'full' ? 'full' : preference === 'auto'
    : false;
  await window.cuppet.permissions.autoSet(session.id, effective).catch(() => undefined);
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

function toolActivityDetail(toolName: string, argumentsJson: string, runtimeDetails?: string) {
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
  if (runtimeDetails) lines.push(`Result: ${compactActivityText(runtimeDetails)}`);
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

function resize(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(180, Math.max(54, node.scrollHeight))}px`;
}

function summarize(value: CommandResult['result']) {
  if (value == null) return 'Command completed.';
  if (typeof value === 'string') return value.slice(0, 600);
  if (typeof value === 'boolean') return value ? 'Enabled.' : 'Disabled.';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.reason === 'string') return record.reason.slice(0, 600);
    if (typeof record.message === 'string') return record.message.slice(0, 600);
    if (typeof record.mode === 'string') return `Mode: ${record.mode}`;
    if (typeof record.enabled === 'boolean') return record.enabled ? 'Enabled.' : 'Disabled.';
    return 'Command completed.';
  }
  return String(value).slice(0, 600);
}

function statusLabel(status: string) {
  if (status === 'streaming') return null;
  if (status === 'stopped') return 'Stopped';
  if (status === 'interrupted') return 'Interrupted by restart';
  if (status === 'error') return 'Generation failed';
  return status;
}
