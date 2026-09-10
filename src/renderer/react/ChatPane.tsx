import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, CommandDefinition, CommandResult, Project, Session } from '../types';
import { ModelPicker } from './ModelPicker';
import { renderMarkdown } from './markdown';

export type DeliveryMode = 'queue' | 'steer';
export type ActivityEntry = {
  id: string;
  kind: 'tool' | 'queue' | 'validation' | string;
  status: 'running' | 'complete' | 'error' | 'queued' | string;
  label: string;
  details?: string;
};

type TraceReasoning = { id: string; type: 'reasoning'; text: string };
type TraceTool = {
  id: string;
  type: 'tool';
  status: 'running' | 'complete' | 'error';
  tool: string;
  argumentsJson: string;
  label: string;
  details?: string;
};
type TraceItem = TraceReasoning | TraceTool;
type Draft = { projectId: string | null; mode: 'plan' | 'build' } | null;

type Props = {
  session: Session | null;
  draft: Draft;
  project: Project | null;
  mode: 'plan' | 'build';
  running: boolean;
  commands: CommandDefinition[];
  activity: ActivityEntry[];
  onSend: (text: string, deliveryMode: DeliveryMode, attachments: Attachment[]) => Promise<{ clear: boolean; commandResult?: CommandResult }>;
  onStop: () => void | Promise<void>;
  onToggleMode: () => void | Promise<void>;
};

export function ChatPane({ session, draft, project, mode, running, commands, activity: _activity, onSend, onStop }: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selected, setSelected] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('queue');
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [traceByMessage, setTraceByMessage] = useState<Record<string, TraceItem[]>>({});
  const [preview, setPreview] = useState<{ messageId: string; content: string } | null>(null);
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

  useEffect(() => setSelected(0), [value]);

  useEffect(() => {
    setAttachments([]);
    if (fileInput.current) fileInput.current.value = '';
  }, [session?.id, draft?.projectId]);

  useEffect(() => {
    setPreview(null);
    setTraceByMessage(loadStoredTraces(session));
  }, [session?.id]);

  useEffect(() => window.cuppet.onEvent((event) => {
    if (!session?.id || String(event?.sessionId ?? '') !== session.id) return;
    const messageId = String(event?.messageId ?? '');

    if (event.type === 'message.reasoning') {
      const segment = typeof event.segment === 'string' ? event.segment.trim() : '';
      if (!messageId || !segment) return;
      setTraceByMessage((current) => {
        const existing = current[messageId] ?? readStoredTrace(messageId, true);
        const last = existing.at(-1);
        const next = last?.type === 'reasoning' && last.text === segment
          ? existing
          : boundTrace([...existing, { id: `reason-${Date.now()}-${existing.length}`, type: 'reasoning', text: segment }]);
        if (next !== existing) storeTrace(messageId, next);
        return next === existing ? current : { ...current, [messageId]: next };
      });
      return;
    }

    if (event.type === 'tool.started' || event.type === 'tool.finished') {
      if (!messageId) return;
      setTraceByMessage((current) => {
        const existing = current[messageId] ?? readStoredTrace(messageId, true);
        const next = updateToolTrace(existing, event);
        storeTrace(messageId, next);
        return { ...current, [messageId]: next };
      });
      return;
    }

    if (event.type === 'message.preview' && messageId) {
      const content = typeof event.content === 'string' ? event.content : '';
      setPreview(content ? { messageId, content } : (current) => current?.messageId === messageId ? null : current);
    }
  }), [session?.id]);

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
  }, [session?.messages, traceByMessage, preview?.content]);

  const submit = async () => {
    const raw = value.trim();
    if (!raw && !attachments.length) return;
    const result = await onSend(raw, deliveryMode, attachments);
    if (result.commandResult) setCommandResult(result.commandResult);
    if (result.clear) {
      setValue('');
      setAttachments([]);
      if (fileInput.current) fileInput.current.value = '';
      resize(textarea.current);
      textarea.current?.focus();
    }
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  const runningPreview = runningAssistant && preview?.messageId === runningAssistant.id ? preview.content : '';
  const runningTrace = runningAssistant ? traceByMessage[runningAssistant.id] ?? [] : [];
  const emptyTitle = project ? 'Start working in this project' : 'Start a conversation';
  const emptyDescription = project ? 'Cuppet can read and work with this project once you send a message.' : 'General chats are not attached to a filesystem project.';

  return (
    <main className="main-pane react-main-pane">
      <section ref={messagesRef} className="messages react-messages" aria-live="polite" tabIndex={0}>
        {!messages.length ? (
          <div className="empty-state"><h1>{emptyTitle}</h1><p>{emptyDescription}</p></div>
        ) : stableMessages.map((message) => <MessageView key={message.id} message={message} trace={traceByMessage[message.id] ?? []} />)}
        {runningAssistant && (runningPreview || runningAssistant.content || runningTrace.length > 0) && (
          <MessageView
            key={runningAssistant.id}
            message={{ ...runningAssistant, content: runningPreview || runningAssistant.content }}
            trace={runningTrace}
            live
          />
        )}
      </section>

      <footer className="composer-wrap react-composer-wrap">
        {commandResult && <CommandResultView result={commandResult} onDismiss={() => setCommandResult(null)} />}
        {palette.length > 0 && <CommandPalette items={palette} selected={selected} sessionAvailable={Boolean(session)} onChoose={choose} />}
        <form className="composer react-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input ref={fileInput} className="composer-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={addFiles} />
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            placeholder={running ? (deliveryMode === 'steer' ? 'Steer the active run…' : 'Queue a message…') : 'Message Cuppet…'}
            autoComplete="off"
            onChange={(event) => { setValue(event.target.value); resize(event.target); }}
            onKeyDown={onKeyDown}
          />
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
            {running && (
              <div className="delivery-controls react-delivery-controls" aria-label="While running">
                <button type="button" className={`delivery-mode-button${deliveryMode === 'queue' ? ' active' : ''}`} onClick={() => setDeliveryMode('queue')}>Queue</button>
                <button type="button" className={`delivery-mode-button${deliveryMode === 'steer' ? ' active' : ''}`} onClick={() => setDeliveryMode('steer')}>Steer</button>
              </div>
            )}
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
    </main>
  );
}

function MessageView({ message, trace = [], live = false }: { message: Session['messages'][number]; trace?: TraceItem[]; live?: boolean }) {
  const [traceOpen, setTraceOpen] = useState(live);
  const [copied, setCopied] = useState(false);
  const status = message.status && message.status !== 'complete' ? statusLabel(message.status) : null;
  const assistant = message.role === 'assistant';
  const content = String(message.content ?? '');
  const hasTrace = assistant && trace.length > 0;
  const canCopy = assistant && !live && message.status !== 'streaming' && Boolean(content.trim());

  useEffect(() => {
    setTraceOpen(live);
  }, [live, message.id]);

  const copySummary = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(content);
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
      {hasTrace && traceOpen && <TraceView trace={trace} />}
      {assistant ? (
        content ? <div className="message-content markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} /> : null
      ) : (
        <div className="message-content">{content}</div>
      )}
      {status && <div className={`message-status${message.status === 'error' ? ' error' : ''}`}>{status}</div>}
      {canCopy && (
        <div className="message-footer-actions message-footer-copy">
          <button type="button" className="message-copy-button" aria-label={copied ? 'Copied' : 'Copy final response'} title={copied ? 'Copied' : 'Copy'} onClick={() => void copySummary()}>
            <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="6.1" y="5.7" width="7" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.25"/><path d="M4.6 11.7H4a1.4 1.4 0 0 1-1.4-1.4V4A1.4 1.4 0 0 1 4 2.6h6.1A1.4 1.4 0 0 1 11.5 4v.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          </button>
        </div>
      )}
    </article>
  );
}

function TraceView({ trace }: { trace: TraceItem[] }) {
  return (
    <div className="message-trace thread-activity" aria-label="Cuppet activity">
      {trace.map((item) => item.type === 'reasoning' ? (
        <div key={item.id} className="message-trace-reasoning markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
      ) : (
        <div key={item.id} className={`thread-activity-line ${item.status}`}>{friendlyActivityLabel({ id: item.id, kind: 'tool', status: item.status, label: item.label, details: item.details })}</div>
      ))}
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

function updateToolTrace(trace: TraceItem[], event: any): TraceItem[] {
  const id = String(event?.executionId ?? event?.callId ?? `tool-${Date.now()}`);
  const existingIndex = trace.findIndex((item) => item.type === 'tool' && item.id === id);
  const existing = existingIndex >= 0 ? trace[existingIndex] as TraceTool : null;
  const tool = String(event?.tool ?? existing?.tool ?? '');
  const argumentsJson = typeof event?.argumentsJson === 'string' ? event.argumentsJson : existing?.argumentsJson ?? '{}';
  const status: TraceTool['status'] = event?.type === 'tool.finished' ? (event?.success === false ? 'error' : 'complete') : 'running';
  const patch: TraceTool = {
    id,
    type: 'tool',
    status,
    tool,
    argumentsJson,
    label: toolActivityLabel(tool, argumentsJson, status),
    ...(typeof event?.message === 'string' && event.message ? { details: event.message } : existing?.details ? { details: existing.details } : {}),
  };
  const next = [...trace];
  if (existingIndex >= 0) next[existingIndex] = patch;
  else next.push(patch);
  return boundTrace(next);
}

function friendlyActivityLabel(entry: ActivityEntry) {
  return entry.label;
}

function toolActivityLabel(toolName = '', argumentsJson = '{}', status: TraceTool['status']) {
  const args = parseToolArguments(argumentsJson);
  const failed = status === 'error';
  const complete = status === 'complete';
  const phrase = (active: string, done: string, error: string) => failed ? error : complete ? done : active;
  const targets = toolTargets(toolName, args);
  const one = targets.length === 1 ? targetName(targets[0]) : '';
  const many = targets.length > 1 ? `${targets.length} files` : '';
  const target = one || many;

  if (toolName === 'tst_read') return target
    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)
    : phrase('Reading…', 'Read files', 'Couldn’t read files');
  if (toolName === 'tst_explore') {
    const focus = toolExploreFocus(args);
    return focus
      ? phrase(`Exploring ${focus}…`, `Explored ${focus}`, `Couldn’t explore ${focus}`)
      : phrase('Exploring…', 'Explored', 'Couldn’t explore');
  }
  if (toolName === 'tst_edit_batch') {
    if (String(args.action ?? '') === 'apply' && !target) return phrase('Applying edits…', 'Applied edits', 'Couldn’t apply edits');
    return target
      ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
      : phrase('Editing files…', 'Edited files', 'Couldn’t edit files');
  }
  if (toolName === 'workspace_edit') return target
    ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
    : phrase('Editing…', 'Edited file', 'Couldn’t edit file');
  if (toolName === 'workspace_write') return target
    ? phrase(`Writing ${target}…`, `Wrote ${target}`, `Couldn’t write ${target}`)
    : phrase('Writing…', 'Wrote file', 'Couldn’t write file');
  if (toolName === 'tst_validate') return target
    ? phrase(`Validating ${target}…`, `Validated ${target}`, `Validation failed for ${target}`)
    : phrase('Validating…', 'Validated', 'Validation failed');
  if (toolName === 'cuppet_memory_search') return phrase('Searching memory…', 'Searched memory', 'Couldn’t search memory');
  if (toolName === 'cuppet_plan') return phrase('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (toolName === 'bash') return phrase('Running command…', 'Ran command', 'Command failed');
  if (toolName === 'question') return phrase('Waiting for input…', 'Received input', 'Input request failed');
  return phrase('Working…', 'Completed', 'Failed');
}

function toolTargets(toolName: string, args: Record<string, unknown>) {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (path && !values.includes(path)) values.push(path);
  };

  if (toolName === 'tst_read') {
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
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query) return compactActivityText(query);
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

const TRACE_KEY_PREFIX = 'cuppet.desktop.trace.';
const LEGACY_REASONING_KEY_PREFIX = 'cuppet.desktop.reasoning.';
const MAX_TRACE_CHARS = 140_000;

function loadStoredTraces(session: Session | null) {
  const output: Record<string, TraceItem[]> = {};
  for (const message of session?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const value = readStoredTrace(message.id, message.status === 'streaming');
    if (value.length) output[message.id] = value;
  }
  return output;
}

function readStoredTrace(messageId: string, keepRunning = false): TraceItem[] {
  try {
    const raw = localStorage.getItem(`${TRACE_KEY_PREFIX}${messageId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed
        .filter(validTraceItem)
        .map((item) => item.type === 'tool' && item.status === 'running' && !keepRunning ? { ...item, status: 'complete', label: toolActivityLabel(item.tool, item.argumentsJson, 'complete') } : item);
    }
    const legacy = localStorage.getItem(`${LEGACY_REASONING_KEY_PREFIX}${messageId}`)?.trim();
    return legacy ? [{ id: 'legacy-reasoning', type: 'reasoning', text: legacy }] : [];
  } catch {
    return [];
  }
}

function validTraceItem(value: unknown): value is TraceItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.type === 'reasoning') return typeof item.id === 'string' && typeof item.text === 'string';
  return item.type === 'tool' && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.tool === 'string' && typeof item.argumentsJson === 'string' && ['running', 'complete', 'error'].includes(String(item.status));
}

function storeTrace(messageId: string, trace: TraceItem[]) {
  try { localStorage.setItem(`${TRACE_KEY_PREFIX}${messageId}`, JSON.stringify(boundTrace(trace))); }
  catch { /* local persistence is best-effort; the final answer remains durable in the runtime DB. */ }
}

function boundTrace(trace: TraceItem[]) {
  let next = trace.slice(-80);
  while (JSON.stringify(next).length > MAX_TRACE_CHARS && next.length > 1) next = next.slice(1);
  return next;
}

function resize(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(180, Math.max(54, node.scrollHeight))}px`;
}

function summarize(value: CommandResult['result']) {
  if (value == null) return 'Completed.';
  if (typeof value === 'string') return value.slice(0, 600);
  if (typeof value === 'boolean') return value ? 'Enabled.' : 'Disabled.';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.reason === 'string') return record.reason.slice(0, 600);
    if (typeof record.message === 'string') return record.message.slice(0, 600);
    if (typeof record.mode === 'string') return `Mode: ${record.mode}`;
    if (typeof record.enabled === 'boolean') return record.enabled ? 'Enabled.' : 'Disabled.';
    return 'Completed.';
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
