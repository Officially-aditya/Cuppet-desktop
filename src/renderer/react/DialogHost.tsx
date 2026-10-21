import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { cancelAll, cancelRequest, getCurrent, resolveRequest, subscribe } from './dialog-store';
import type { DialogRequest } from './dialog-store';

/**
 * Renders the request at the head of the dialog queue as a native modal <dialog>. showModal() gives a real focus
 * trap, an inert background, Escape handling (the `cancel` event) and focus restoration, which is what the
 * hand-rolled modals lack. Mount it once, near the root.
 */
export function DialogHost() {
  const request = useSyncExternalStore(subscribe, getCurrent, () => null);
  // Never leave a caller awaiting a dialog that will not be shown.
  useEffect(() => () => cancelAll(), []);
  return request ? <DialogView key={request.id} request={request} /> : null;
}

function DialogView({ request }: { request: DialogRequest }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={ref}
      className="cuppet-dialog"
      aria-labelledby={titleId}
      aria-describedby={request.message ? messageId : undefined}
      // Escape: stop the browser closing the dialog itself, so the request settles through the queue.
      onCancel={(event) => { event.preventDefault(); cancelRequest(request.id); }}
      // The form fills the dialog, so only a click on the backdrop has the dialog itself as its target.
      onClick={(event) => { if (event.target === event.currentTarget) cancelRequest(request.id); }}
    >
      <DialogContent request={request} titleId={titleId} messageId={messageId} />
    </dialog>
  );
}

export function DialogContent({ request, titleId, messageId }: { request: DialogRequest; titleId: string; messageId: string }) {
  const fieldBase = useId();
  const [values, setValues] = useState<Record<string, string>>(() => (
    request.kind === 'form' ? Object.fromEntries(request.fields.map((field) => [field.name, field.defaultValue ?? ''])) : {}
  ));
  const [choice, setChoice] = useState(() => (request.kind === 'choice' ? initialChoice(request) : ''));
  const formRef = useRef<HTMLFormElement>(null);

  const valid = request.kind !== 'form' || request.fields.every((field) => field.required === false || (values[field.name] ?? '').trim() !== '');
  const confirmLabel = request.confirmLabel ?? (request.kind === 'confirm' ? 'Confirm' : 'OK');

  const submit = () => {
    if (!valid) return;
    if (request.kind === 'form') resolveRequest(request.id, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()])));
    else if (request.kind === 'choice') resolveRequest(request.id, choice);
    else resolveRequest(request.id, true);
  };

  const submitOnModifiedEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter adds a line in a multi-line field, so Ctrl/Cmd+Enter submits.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  return (
    <form ref={formRef} className="cuppet-dialog-form" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <h2 className="cuppet-dialog-title" id={titleId}>{request.title}</h2>
      {request.message && <p className="cuppet-dialog-message" id={messageId}>{request.message}</p>}

      {request.kind === 'form' && request.fields.map((field) => {
        const id = `${fieldBase}-${field.name}`;
        const set = (value: string) => setValues((current) => ({ ...current, [field.name]: value }));
        return (
          <div className="cuppet-dialog-field" key={field.name}>
            <label htmlFor={id}>{field.label}</label>
            {field.multiline
              ? <textarea id={id} rows={4} value={values[field.name] ?? ''} placeholder={field.placeholder} onChange={(event) => set(event.target.value)} onKeyDown={submitOnModifiedEnter} />
              : <input id={id} type="text" value={values[field.name] ?? ''} placeholder={field.placeholder} autoComplete="off" spellCheck={false} onChange={(event) => set(event.target.value)} />}
          </div>
        );
      })}

      {request.kind === 'choice' && (
        <div className="cuppet-dialog-choices" role="radiogroup" aria-labelledby={titleId}>
          {request.options.map((option) => (
            <label className="cuppet-dialog-choice" key={option.value}>
              <input type="radio" name={`${fieldBase}-choice`} value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} />
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="cuppet-dialog-actions">
        {/* Cancel comes first in the DOM so it is the first focusable element of a confirmation: the safe default. */}
        <button type="button" className="cuppet-dialog-button" onClick={() => cancelRequest(request.id)}>{request.cancelLabel ?? 'Cancel'}</button>
        <button type="submit" className={`cuppet-dialog-button primary${request.destructive ? ' danger' : ''}`} disabled={!valid}>{confirmLabel}</button>
      </div>
    </form>
  );
}

function initialChoice(request: Extract<DialogRequest, { kind: 'choice' }>) {
  return request.options.some((option) => option.value === request.defaultValue) ? (request.defaultValue as string) : request.options[0].value;
}
