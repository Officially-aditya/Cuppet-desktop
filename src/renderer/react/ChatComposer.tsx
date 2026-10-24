import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';
import type { Attachment, QueuedTurn, Session } from '../types';
import type { ChatPaneProps, DeliveryMode } from './ChatPane';
import type { ContextUsage } from './chat-transcript';
import { ModelPicker } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { QuestionInline } from './QuestionModal';
import { PermissionModal } from './PermissionModal';
import { useChatPalette, removeBrowserControlMention } from './use-chat-palette';
import { GENERAL_SETTINGS_EVENT, readPermissionMode, readSendBehavior } from './behavior-preferences';

const BROWSERCONTROL_MENTION = '@browserControl';
export type ChatComposerHandle = { ingestFiles: (files: File[]) => Promise<void> };
type Props = ChatPaneProps & {
  ref?: Ref<ChatComposerHandle>;
  paneRef?: RefObject<HTMLElement | null>;
  contextUsage?: ContextUsage;
  onSubmitStart?: () => void;
  onOpenLightbox: (image: { src: string; name?: string }) => void;
};

export function ChatComposer({ ref, paneRef: externalPaneRef, contextUsage, onSubmitStart, onOpenLightbox,
  session, draft, mode, activeMode, running, commands, queuedTurns = [], onCancelQueued, onSteerQueued,
  onSend, onStop, onModeChange, question, onAnswerQuestion, permission, onResolvePermission }: Props) {
  const composerKey = session?.id ? `session:${session.id}` : `draft:${draft?.projectId ?? 'general'}`;
  const [composerDrafts, setComposerDrafts] = useState<Record<string, { text: string; attachments: Attachment[] }>>({});
  const value = composerDrafts[composerKey]?.text ?? '';
  const attachments = composerDrafts[composerKey]?.attachments ?? [];
  const setValue = (next: string | ((current: string) => string)) => {
    setComposerDrafts((current) => {
      const composer = current[composerKey] ?? { text: '', attachments: [] };
      return { ...current, [composerKey]: { ...composer, text: typeof next === 'function' ? next(composer.text) : next } };
    });
  };
  const setAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    setComposerDrafts((current) => {
      const composer = current[composerKey] ?? { text: '', attachments: [] };
      return { ...current, [composerKey]: { ...composer, attachments: typeof next === 'function' ? next(composer.attachments) : next } };
    });
  };
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(() => readSendBehavior());
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const localPaneRef = useRef<HTMLElement | null>(null);
  const paneRef = externalPaneRef ?? localPaneRef;
  const historyRef = useRef<{ messageId: string; draft: { text: string; attachments: Attachment[] } } | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const composerRef = useRef({ key: composerKey, value, attachments });
  composerRef.current = { key: composerKey, value, attachments };

  useEffect(() => {
    const updateSelection = () => {
      // Composer caret changes are not transcript selections. Reading the document
      // selection here can force layout of a concurrently changing transcript.
      if (document.activeElement === textarea.current) {
        setSelectionMenu(null);
        return;
      }
      const selection = window.getSelection();
      const pane = paneRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !pane ||
          !selection.anchorNode || !selection.focusNode ||
          !pane.contains(selection.anchorNode) || !pane.contains(selection.focusNode)) {
        setSelectionMenu(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setSelectionMenu(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSelectionMenu({
        text,
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 196)),
        y: rect.bottom + 48 > window.innerHeight ? Math.max(8, rect.top - 44) : rect.bottom + 8,
      });
    };
    const dismiss = () => setSelectionMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.chat-selection-menu')) dismiss();
    };
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  const addSelectionToChat = () => {
    if (!selectionMenu) return;
    setValue((current) => current + (current ? '\n\n' : '') + selectionMenu.text);
    historyRef.current = null;
    setSelectionMenu(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
      resize(node);
    });
  };

  const focusComposer = () => requestAnimationFrame(() => {
    const node = textarea.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    resize(node);
  });
  const { setCommandResult, browserControlMentioned, handlePaletteKey, paletteView } = useChatPalette({
    value, setValue, commands, session, mode, composerKey, contextUsage, focusComposer,
  });

  useEffect(() => {
    resize(textarea.current);
  }, [value]);

  useEffect(() => {
    historyRef.current = null;
    setSelectionMenu(null);
    setCommandResult(null);
    if (fileInput.current) fileInput.current.value = '';
  }, [composerKey]);

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

  const clearComposer = () => {
    setComposerDrafts((current) => {
      const composer = current[composerKey];
      if (!composer || composer.text !== value || composer.attachments !== attachments) return current;
      const next = { ...current };
      delete next[composerKey];
      return next;
    });
    const latest = composerRef.current;
    if (latest.key !== composerKey || latest.value !== value || latest.attachments !== attachments) return;
    historyRef.current = null;
    if (fileInput.current) fileInput.current.value = '';
    if (textarea.current) textarea.current.style.height = '54px';
    textarea.current?.focus();
  };

  const submit = async () => {
    const raw = value.trim();
    if (!raw && !attachments.length) return;
    onSubmitStart?.();
    // The runtime owns queueing so queued work survives renderer reloads and there is
    // only one authority for ordering, capacity, dispatch, and failure semantics.
    const result = await onSend(raw, deliveryMode, attachments);
    if (result.commandResult && composerRef.current.key === composerKey) setCommandResult(result.commandResult);
    if (result.clear) clearComposer();
  };

function imageMimeFromName(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg':
    case 'jfif': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    default: return null;
  }
}

  const ingestFiles = async (files: File[]) => {
    if (!files.length) return;
    const loaded = await Promise.all(
      files.map(async (file) => {
        const inferredMime = file.type || imageMimeFromName(file.name) || undefined;
        const attachment: Attachment = {
          name: file.name,
          ...(inferredMime ? { mime: inferredMime } : {}),
          size: file.size,
        };
        const isImage = (inferredMime && inferredMime.startsWith('image/')) || file.type.startsWith('image/');
        if (isImage) {
          try {
            const blobToRead = inferredMime && inferredMime !== file.type ? new Blob([file], { type: inferredMime }) : file;
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blobToRead);
            });
            if (dataUrl) attachment.dataUrl = dataUrl;
          } catch {
            // Keep metadata on read error
          }
        }
        return attachment;
      })
    );
    setAttachments((current) => {
      const next = [...current];
      const seen = new Set(next.map(attachmentKey));
      for (const attachment of loaded) {
        if (next.length >= 16) break;
        const key = attachmentKey(attachment);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(attachment);
      }
      return next;
    });
  };

  const addFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void ingestFiles(files);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const extension = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
          const named = new File([file], `Pasted-Image-${Date.now()}.${extension}`, { type: file.type });
          imageFiles.push(named);
        }
      }
    }
    if (imageFiles.length === 0 && event.clipboardData?.files?.length) {
      for (const file of Array.from(event.clipboardData.files)) {
        const mime = file.type || imageMimeFromName(file.name);
        if (mime && mime.startsWith('image/')) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      void ingestFiles(imageFiles);
    }
  };

  const handleEditQueued = (turn: QueuedTurn) => {
    const text = String(turn.params?.text ?? '');
    const turnAttachments = Array.isArray(turn.params?.attachments) ? turn.params.attachments : [];
    setValue(text);
    if (turnAttachments.length) setAttachments(turnAttachments);
    if (onCancelQueued) void onCancelQueued(turn.id);
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (node) {
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
        resize(node);
      }
    });
  };

  const handleSteerQueued = (turn: QueuedTurn) => {
    if (onSteerQueued) {
      void onSteerQueued(turn);
      return;
    }
    if (session?.id) {
      const text = String(turn.params?.text ?? '').trim();
      if (!text) return;
      if (onCancelQueued) void onCancelQueued(turn.id);
      void window.cuppet.commands.execute(session.id, {
        id: 'cuppet.steer.interrupt',
        input: {
          text: text.slice(0, 8192),
          ...(Array.isArray(turn.params?.attachments) && turn.params.attachments.length ? { attachments: turn.params.attachments } : {}),
        },
      });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handlePaletteKey(event)) return;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
      const node = event.currentTarget;
      const up = event.key === 'ArrowUp';
      const atBoundary = node.selectionStart === node.selectionEnd && (up
        ? !value.slice(0, node.selectionStart).includes('\n')
        : !value.slice(node.selectionEnd).includes('\n'));
      const sent = session?.messages?.filter((message) => message.role === 'user') ?? [];
      const cursor = historyRef.current;
      if (atBoundary && sent.length && (up || cursor)) {
        const currentIndex = cursor ? sent.findIndex((message) => message.id === cursor.messageId) : sent.length;
        const nextIndex = up ? Math.max(0, currentIndex - 1) : currentIndex + 1;
        event.preventDefault();
        if (nextIndex >= sent.length) {
          setValue(cursor!.draft.text);
          setAttachments(cursor!.draft.attachments);
          historyRef.current = null;
        } else {
          const message = sent[nextIndex];
          historyRef.current = {
            messageId: message.id,
            draft: cursor?.draft ?? { text: value, attachments },
          };
          setValue(message.content ?? '');
          setAttachments(message.attachments ?? []);
        }
        requestAnimationFrame(() => {
          node.setSelectionRange(node.value.length, node.value.length);
          resize(node);
        });
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    updateOnline();
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);


  useImperativeHandle(ref, () => ({ ingestFiles }));

  return (
    <>
      {selectionMenu && (
        <div className="chat-selection-menu" role="group" aria-label="Selected text actions"
          style={{ left: selectionMenu.x, top: selectionMenu.y }} onMouseDown={(event) => event.preventDefault()}>
          <button type="button" onClick={() => {
            void window.cuppet.native.copyText(selectionMenu.text).then(() => setSelectionMenu(null)).catch(() => undefined);
          }}>Copy</button>
          <button type="button" onClick={addSelectionToChat}>Add to chat</button>
        </div>
      )}
      <footer className="composer-wrap react-composer-wrap">
        {permission && onResolvePermission && <PermissionModal key={permission.id} request={permission} onResolve={onResolvePermission} />}
        {question && (
          <div className="question-messages-container" aria-label="Questions from Cuppet">
            <QuestionInline request={question} onAnswer={onAnswerQuestion || (() => {})} />
          </div>
        )}
        {queuedTurns.length > 0 && (
          <div className="queued-messages-container" aria-label="Queued messages">
            {queuedTurns.map((turn, index) => (
              <QueuedTurnBar
                key={turn.id}
                turn={turn}
                index={index}
                total={queuedTurns.length}
                onCancel={() => void onCancelQueued?.(turn.id)}
                onEdit={() => handleEditQueued(turn)}
                onSteer={() => handleSteerQueued(turn)}
                onOpenLightbox={(img) => onOpenLightbox(img)}
              />
            ))}
          </div>
        )}
        {paletteView}
        <form className="composer react-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input ref={fileInput} className="composer-file-input" type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.tsx,.jsx" tabIndex={-1} aria-hidden="true" onChange={addFiles} />
          <textarea
            ref={textarea}
            rows={1}
            value={value}
            placeholder="Message Cuppet…"
            aria-label="Message Cuppet"
            autoComplete="off"
            onChange={(event) => { setValue(event.target.value); resize(event.target); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {browserControlMentioned && (
            <div className="composer-integration-chips" aria-label="Active integrations">
              <button type="button" className="composer-integration-chip" title="Remove browserControl" onClick={() => setValue((current) => removeBrowserControlMention(current))}>
                <span>{BROWSERCONTROL_MENTION}</span><span aria-hidden="true">×</span>
              </button>
            </div>
          )}
          <div className="composer-actions react-composer-actions">
            <button type="button" className="composer-attach-button" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
            <ModePicker value={activeMode} onChange={(next) => void onModeChange(next)} disabled={running} />
            {!online && (
              <span className="composer-connection-status" role="status" title="Check your connection. Messages may be interrupted while offline.">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="m3 3 14 14M7 5.3a12 12 0 0 1 9.8 3.1M3.2 8.4a12 12 0 0 1 1.9-1.5M10.2 9a8 8 0 0 1 3.7 1.7M6.1 10.7a8 8 0 0 1 1.6-1M8.4 13.2a4 4 0 0 1 3.2 0M10 16h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>No connection</span>
              </span>
            )}
            {attachments.length > 0 && (
              <div className="composer-attachments" aria-label="Attached files">
                {attachments.map((attachment, index) => (
                  <div className="composer-attachment" key={`${attachmentKey(attachment)}:${index}`}>
                    {attachment.dataUrl ? (
                      <img
                        src={attachment.dataUrl}
                        alt=""
                        className="composer-attachment-thumb"
                        onClick={() => onOpenLightbox({ src: attachment.dataUrl!, name: attachment.name })}
                        title="Click to preview image"
                      />
                    ) : (
                      <span className="composer-attachment-icon">📎</span>
                    )}
                    <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                    <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                  </div>
                ))}
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
    </>
  );
}

function attachmentKey(value: Attachment) {
  return `${value.name}:${value.size ?? ''}:${value.mime ?? ''}:${value.dataUrl ? value.dataUrl.slice(0, 48) : ''}`;
}

async function applyPermissionPreference(session: Session | null) {
  if (!session?.id) return;
  const preference = readPermissionMode();
  const effective: boolean | 'full' = session.projectId
    ? preference === 'full' ? 'full' : preference === 'auto'
    : false;
  await window.cuppet.permissions.autoSet(session.id, effective).catch(() => undefined);
}

function resize(node: HTMLTextAreaElement | null) {
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(180, Math.max(54, node.scrollHeight))}px`;
}

function QueuedTurnBar({
  turn,
  index,
  total,
  onCancel,
  onEdit,
  onSteer,
  onOpenLightbox,
}: {
  turn: QueuedTurn;
  index: number;
  total: number;
  onCancel: () => void;
  onEdit: () => void;
  onSteer: () => void;
  onOpenLightbox?: (image: { src: string; name?: string }) => void;
}) {
  const text = String(turn.params?.text ?? '');
  const attachments = Array.isArray(turn.params?.attachments) ? turn.params.attachments : [];
  const label = total > 1 ? `Queued message (#${index + 1})` : 'Queued message';

  return (
    <div className="queued-turn-bar" role="status" aria-label={label}>
      <div className="queued-turn-copy">
        <div className="queued-turn-title">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
            <path d="M8 4.5v3.8l2.4 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span>{label}</span>
          <span className="queued-turn-subtitle">· will send when Cuppet finishes</span>
        </div>
        <div className="queued-turn-content" title={text || undefined}>
          {text || (attachments.length ? 'Files only' : 'Empty prompt')}
        </div>
        {attachments.length > 0 && (
          <div className="queued-turn-attachments">
            <span>📎 {attachments.length} {attachments.length === 1 ? 'file' : 'files'} attached</span>
            {attachments.some((a) => a.dataUrl) && (
              <div className="queued-turn-thumbs">
                {attachments
                  .filter((a) => a.dataUrl)
                  .map((a, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="queued-turn-thumb-btn"
                      onClick={() => onOpenLightbox?.({ src: a.dataUrl!, name: a.name })}
                      title={a.name ? `Preview ${a.name}` : 'Preview image'}
                    >
                      <img
                        src={a.dataUrl}
                        alt={a.name || 'Queued attachment'}
                        className="queued-turn-thumb"
                      />
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="queued-turn-actions">
        <button
          type="button"
          className="queued-turn-button steer"
          aria-label="Add queued message to the current turn"
          title="Add this message to the current turn without stopping Cuppet"
          onClick={onSteer}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6.3 8H2M9.7 8H14M8 9.7V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="queued-turn-button"
          aria-label="Edit queued message"
          title="Put back into input box"
          onClick={onEdit}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
            <path d="M11 2.5 13.5 5 5 13.5H2.5V11L11 2.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="queued-turn-button danger"
          aria-label="Cancel queued message"
          title="Delete queued message"
          onClick={onCancel}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14" height="14" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}


