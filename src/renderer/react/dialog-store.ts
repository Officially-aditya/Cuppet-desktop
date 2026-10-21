// Promise-based dialogs that replace window.prompt() and window.confirm().
//
// Electron does not implement prompt(), and confirm() blocks the whole renderer, so neither can be relied on.
// Callers await askText/askChoice/askConfirm/askForm; the DialogHost component renders the request at the head of
// the queue as a native <dialog>. Requests queue first-in first-out, and every request settles exactly once:
// cancelling resolves null (or false for a confirmation), so an awaiting caller never hangs.

export type FormField = {
  name: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  /** Defaults to true: an empty (or whitespace-only) value cannot be submitted. */
  required?: boolean;
};

export type ChoiceOption = { value: string; label: string; description?: string };

type Common = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  destructive?: boolean;
};

export type DialogSpec =
  | (Common & { kind: 'form'; fields: FormField[] })
  | (Common & { kind: 'choice'; options: ChoiceOption[]; defaultValue?: string })
  | (Common & { kind: 'confirm' });

export type DialogRequest = DialogSpec & { id: number };
export type DialogAnswer = Record<string, string> | string | boolean | null;

type Pending = { request: DialogRequest; settle: (answer: DialogAnswer) => void };

let nextId = 1;
const queue: Pending[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function enqueue<T extends DialogAnswer>(spec: DialogSpec, cancelled: T): Promise<DialogAnswer> {
  return new Promise((resolve) => {
    queue.push({ request: { ...spec, id: nextId++ }, settle: resolve });
    emit();
  }).then((answer) => (answer === null ? cancelled : (answer as DialogAnswer)));
}

/** Subscribes to changes of the head of the queue (for useSyncExternalStore). */
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The request to show now, or null. The same object is returned until the head of the queue changes. */
export function getCurrent(): DialogRequest | null {
  return queue[0]?.request ?? null;
}

/** Settles a request with an answer. A request that has already settled is ignored. */
export function resolveRequest(id: number, answer: DialogAnswer) {
  const index = queue.findIndex((pending) => pending.request.id === id);
  if (index === -1) return false;
  const [pending] = queue.splice(index, 1);
  pending.settle(answer);
  emit();
  return true;
}

/** Cancels one request: a form, choice or text resolves null, a confirmation resolves false. */
export function cancelRequest(id: number) {
  const pending = queue.find((item) => item.request.id === id);
  if (!pending) return false;
  return resolveRequest(id, pending.request.kind === 'confirm' ? false : null);
}

/** Cancels everything still waiting, so no caller is left awaiting a dialog that will never be shown. */
export function cancelAll() {
  for (const pending of [...queue]) cancelRequest(pending.request.id);
}

/** Asks for several values at once. Resolves the trimmed values by field name, or null if cancelled. */
export async function askForm(spec: Common & { fields: FormField[] }): Promise<Record<string, string> | null> {
  if (!spec.fields.length) return null;
  const answer = await enqueue({ ...spec, kind: 'form' }, null);
  return answer && typeof answer === 'object' ? (answer as Record<string, string>) : null;
}

/** Asks for one line (or block) of text. Resolves the trimmed text, or null if cancelled. */
export async function askText(spec: Common & Omit<FormField, 'name'>): Promise<string | null> {
  const { title, message, confirmLabel, cancelLabel, destructive, ...field } = spec;
  const answer = await askForm({ title, message, confirmLabel, cancelLabel, destructive, fields: [{ ...field, name: 'value' }] });
  return answer?.value ?? null;
}

/** Asks the user to pick one option. Resolves the option's value, or null if cancelled. */
export async function askChoice(spec: Common & { options: ChoiceOption[]; defaultValue?: string }): Promise<string | null> {
  if (!spec.options.length) return null;
  const answer = await enqueue({ ...spec, kind: 'choice' }, null);
  return typeof answer === 'string' ? answer : null;
}

/** Asks for confirmation. Resolves true only on an explicit confirm; cancelling, Escape and clicking away are false. */
export async function askConfirm(spec: Common): Promise<boolean> {
  return (await enqueue({ ...spec, kind: 'confirm' }, false)) === true;
}
