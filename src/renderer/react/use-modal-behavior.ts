import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Escape, focus trapping, initial focus and focus return for the hand-rolled modals (settings, remote, add project,
// new chat). They keep their existing markup and styling; this adds the behaviour a modal dialog is expected to have.
// The logic is plain and takes its document as a parameter so it can be tested without a browser.

type FocusableLike = {
  focus: (options?: { preventScroll?: boolean }) => void;
  getClientRects?: () => { length: number };
  getAttribute?: (name: string) => string | null;
  disabled?: boolean;
  hidden?: boolean;
  type?: string;
};

type RootLike = FocusableLike & {
  contains: (node: unknown) => boolean;
  querySelectorAll: (selector: string) => ArrayLike<FocusableLike>;
};

type KeyEventLike = { key: string; shiftKey?: boolean; defaultPrevented: boolean; preventDefault: () => void };

type DocumentLike = {
  activeElement: unknown;
  body: unknown;
  querySelector: (selector: string) => unknown;
  addEventListener: (type: 'keydown', listener: (event: KeyEventLike) => void) => void;
  removeEventListener: (type: 'keydown', listener: (event: KeyEventLike) => void) => void;
};

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]';

// Modals that are open now, oldest first. Only the newest reacts to the keyboard.
const stack: object[] = [];

/** Elements inside root that a Tab key press can reach, in DOM order. */
export function focusableWithin(root: RootLike): FocusableLike[] {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((element) => (
    !element.disabled
    && !element.hidden
    && element.type !== 'hidden'
    && element.getAttribute?.('tabindex') !== '-1'
    // Excludes anything inside a display:none or [hidden] ancestor; unlike offsetParent it keeps fixed elements.
    && (element.getClientRects?.().length ?? 1) > 0
  ));
}

/**
 * Makes `root` behave as a modal dialog until the returned function is called:
 * - focus moves into it (unless it is already there) and goes back to where it came from afterwards;
 * - Tab and Shift+Tab wrap around inside it;
 * - Escape calls onClose, but only for the newest open modal, only if nothing inside already handled the key (an open
 *   dropdown closes first), and never while a native <dialog> is open on top.
 */
export function attachModalBehavior(root: RootLike, onClose: () => void, doc: DocumentLike): () => void {
  const token = {};
  stack.push(token);
  const previous = doc.activeElement as (FocusableLike & { isConnected?: boolean }) | null;

  if (!root.contains(doc.activeElement)) (focusableWithin(root)[0] ?? root).focus({ preventScroll: true });

  const onKeyDown = (event: KeyEventLike) => {
    if (stack[stack.length - 1] !== token) return;

    if (event.key === 'Escape') {
      if (event.defaultPrevented || doc.querySelector('dialog[open]')) return;
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== 'Tab') return;
    const items = focusableWithin(root);
    if (!items.length) { event.preventDefault(); root.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;

    if (!active || active === doc.body) {
      // Focus fell out of the modal (for example after clicking the backdrop): bring it back.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (root.contains(active)) {
      const index = items.indexOf(active as FocusableLike);
      if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (index === 0 || index === -1)) { event.preventDefault(); last.focus(); }
    }
    // Focus somewhere else that is not the page body (a menu portalled out of the modal) is left alone.
  };

  doc.addEventListener('keydown', onKeyDown);

  return () => {
    doc.removeEventListener('keydown', onKeyDown);
    const index = stack.indexOf(token);
    if (index !== -1) stack.splice(index, 1);
    const active = doc.activeElement;
    // Give focus back unless the user has deliberately moved it somewhere else that still exists.
    if (previous && typeof previous.focus === 'function' && previous.isConnected !== false && (!active || active === doc.body || root.contains(active))) previous.focus({ preventScroll: true });
  };
}

/** Gives a modal's root element Escape handling, a focus trap, initial focus and focus return. */
export function useModalBehavior(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    return attachModalBehavior(root as unknown as RootLike, () => close.current(), document as unknown as DocumentLike);
  }, [ref]);
}
