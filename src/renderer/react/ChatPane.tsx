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

export function ChatPane({ session, draft, project, mode, running, commands, activity, onSend, onStop }: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [selected, setSelected] = useState(0);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('queue');
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [reasoningByMessage, setReasoningByMessage] = useState<Record<string, string>>({});
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

  const transientActivity = useMemo(() => running ? compactActivity(activity) : [], [activity, running]);

  useEffect(() => setSelected(0), [value]);

  useEffect(() => {
    setAttachments([]);
    if (fileInput.current) fileInput.current.value = '';
  }, [session?.id, draft?.projectId]);

  useEffect(() => {
    setPreview(null);
    setReasoningByMessage(loadStoredReasoning(session));
  }, [session?.id]);

  useEffect(() => window.cuppet.onEvent((event) => {
    const messageId = String(event?.messageId ?? '');
    if (!messageId) return;
    if (event.type === 'message.reasoning') {
      const segment = typeof event.segment === 'string' ? event.segment.trim() : '';
      if (!segment) return;
      const existing = readStoredReasoning(messageId);
      const next = boundReasoning(existing ? `${existing}\n\n${segment}` : segment);
      storeReasoning(messageId, next);
      if (session?.id && String(event?.sessionId ?? '') === session.id) setReasoningByMessage((current) => ({ ...current, [messageId]: next }));
      return;
    }
    if (event.type === 'message.preview' && session?.id && String(event?.sessionId ?? '') === session.id) {
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
  }, [session?.messages, transientActivity.length, preview?.content]);

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
  const runningReasoning = runningAssistant ? reasoningByMessage[runningAssistant.id] ?? '' : '';
  const emptyTitle = project ? 'Start working in this project' : 'Start a conversation';
  const emptyDescription = project ? 'Cuppet can read and work with this project once you send a message.' : 'General chats are not attached to a filesystem project.';

  return (
    <main className="main-pane react-main-pane">
      <section ref={messagesRef} className="messages react-messages" aria-live="polite" tabIndex={0}>
        {!messages.length ? (
          <div className="empty-state"><h1>{emptyTitle}</h1><p>{emptyDescription}</p></div>
        ) : stableMessages.map((message) => <MessageView key={message.id} message={message} reasoning={reasoningByMessage[message.id] ?? ''} />)}
        {transientActivity.length > 0 && (
          <div className="thread-activity" aria-label="Agent activity">
            {transientActivity.slice(-12).map((entry) => (
              <div key={entry.id} className={`thread-activity-line ${entry.status || 'complete'}`}>{friendlyActivityLabel(entry)}</div>
            ))}
          </div>
        )}
        {runningAssistant && (runningPreview || runningAssistant.content || runningReasoning) && (
          <MessageView
            key={runningAssistant.id}
            message={{ ...runningAssistant, content: runningPreview || runningAssistant.content }}
            reasoning={runningReasoning}
            preview={Boolean(runningPreview)}
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

function MessageView({ message, reasoning = '', preview = false }: { message: Session['messages'][number]; reasoning?: string; preview?: boolean }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = message.status && message.status !== 'complete' ? statusLabel(message.status) : null;
  const assistant = message.role === 'assistant';
  const content = String(message.content ?? '');
  const canCopy = assistant && !preview && message.status !== 'streaming' && Boolean(content.trim());

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
    <article className={`message ${message.role}${preview ? ' message-preview' : ''}`} data-message-id={message.id}>
      <div className="message-role">{assistant ? 'Cuppet' : 'You'}</div>
      {assistant ? (
        content ? <div className="message-content markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} /> : null
      ) : (
        <div className="message-content">{content}</div>
      )}
      {status && <div className={`message-status${message.status === 'error' ? ' error' : ''}`}>{status}</div>}
      {assistant && (reasoning || canCopy) && (
        <div className="message-footer-actions">
          {reasoning && (
            <div className={`message-reasoning${reasoningOpen ? ' open' : ''}`}>
              <button type="button" className="message-reasoning-toggle" aria-expanded={reasoningOpen} onClick={() => setReasoningOpen((current) => !current)}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span>Reasoning</span>
              </button>
              {reasoningOpen && <div className="message-reasoning-content markdown-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(reasoning) }} />}
            </div>
          )}
          {canCopy && (
            <button type="button" className="message-copy-button" aria-label={copied ? 'Copied' : 'Copy final response'} title={copied ? 'Copied' : 'Copy'} onClick={() => void copySummary()}>
              <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="6.1" y="5.7" width="7" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.25"/><path d="M4.6 11.7H4a1.4 1.4 0 0 1-1.4-1.4V4A1.4 1.4 0 0 1 4 2.6h6.1A1.4 1.4 0 0 1 11.5 4v.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
            </button>
          )}
        </div>
      )}
    </article>
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

function friendlyActivityLabel(entry: ActivityEntry) {
  if (entry.kind !== 'tool') return entry.label;
  const raw = String(entry.label || '').toLowerCase();
  const failed = entry.status === 'error' || raw.includes(' failed');
  const complete = entry.status === 'complete' || raw.includes(' finished') || raw.includes(' completed');
  const state = (active: string, done: string, error: string) => failed ? error : complete ? done : active;

  if (raw.includes('tst_read')) return state('Reading file…', 'Read file', 'Couldn’t read file');
  if (raw.includes('tst_explore')) return state('Exploring…', 'Explored', 'Couldn’t explore');
  if (raw.includes('tst_edit_batch')) return state('Editing files…', 'Edited files', 'Couldn’t edit files');
  if (raw.includes('tst_validate')) return state('Validating…', 'Validated', 'Validation failed');
  if (raw.includes('workspace_write')) return state('Writing file…', 'Wrote file', 'Couldn’t write file');
  if (raw.includes('workspace_edit')) return state('Editing file…', 'Edited file', 'Couldn’t edit file');
  if (raw.includes('cuppet_memory_search')) return state('Searching memory…', 'Searched memory', 'Couldn’t search memory');
  if (raw.includes('cuppet_plan')) return state('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (/\bbash\b/.test(raw)) return state('Running command…', 'Ran command', 'Command failed');
  if (/\bquestion\b/.test(raw)) return state('Waiting for input…', 'Received input', 'Input request failed');

  const internal = raw.match(/(?:running\s+)?([a-z0-9]+(?:_[a-z0-9]+)+)(?:\s+(?:finished|completed|failed))?/i)?.[1];
  if (internal) {
    const readable = internal.replace(/^(?:tst|cuppet|workspace)_/, '').replaceAll('_', ' ');
    return state(`${capitalize(readable)}…`, capitalize(readable), `${capitalize(readable)} failed`);
  }
  return entry.label;
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function compactActivity(activity: ActivityEntry[]) {
  const output: ActivityEntry[] = [];
  let previous = '';
  for (const entry of activity) {
    const key = `${entry.kind}:${entry.status}:${entry.label}:${entry.details ?? ''}`;
    if (key === previous) continue;
    previous = key;
    output.push(entry);
  }
  return output;
}

const REASONING_KEY_PREFIX = 'cuppet.desktop.reasoning.';
const MAX_REASONING_CHARS = 120_000;

function loadStoredReasoning(session: Session | null) {
  const output: Record<string, string> = {};
  for (const message of session?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const value = readStoredReasoning(message.id);
    if (value) output[message.id] = value;
  }
  return output;
}

function readStoredReasoning(messageId: string) {
  try { return localStorage.getItem(`${REASONING_KEY_PREFIX}${messageId}`) ?? ''; }
  catch { return ''; }
}

function storeReasoning(messageId: string, value: string) {
  try { localStorage.setItem(`${REASONING_KEY_PREFIX}${messageId}`, value); }
  catch { /* local persistence is best-effort; the final answer remains durable in the runtime DB. */ }
}

function boundReasoning(value: string) {
  if (value.length <= MAX_REASONING_CHARS) return value;
  return `…\n\n${value.slice(value.length - MAX_REASONING_CHARS + 2)}`;
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
