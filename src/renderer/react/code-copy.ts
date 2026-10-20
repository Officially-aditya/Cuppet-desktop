// The copy button on rendered code blocks. renderMarkdown emits <button data-cuppet-copy> inside .md-code-block;
// MarkdownContent calls copyCodeBlock from its React onClick, so nothing observes or patches the DOM.

type CopyBridge = { copyText?: (text: string) => Promise<unknown> };

type ElementLike = {
  closest?: (selector: string) => ElementLike | null;
  querySelector?: (selector: string) => ElementLike | null;
  setAttribute?: (name: string, value: string) => void;
  textContent: string | null;
};

const FEEDBACK_MS = 1500;
const originals = new WeakMap<object, { label: string; ariaLabel: string }>();
const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

function closest(target: unknown, selector: string): ElementLike | null {
  const node = target as ElementLike | null | undefined;
  return node && typeof node.closest === 'function' ? node.closest(selector) : null;
}

/** Shows brief feedback on the button, then restores its original label. */
function flash(button: ElementLike, label: string, ariaLabel: string) {
  clearTimeout(timers.get(button));
  if (!originals.has(button)) originals.set(button, { label: button.textContent ?? 'Copy', ariaLabel: 'Copy code' });
  button.textContent = label;
  button.setAttribute?.('aria-label', ariaLabel);
  timers.set(button, setTimeout(() => {
    const original = originals.get(button);
    if (original) {
      button.textContent = original.label;
      button.setAttribute?.('aria-label', original.ariaLabel);
    }
    originals.delete(button);
    timers.delete(button);
  }, FEEDBACK_MS));
}

/**
 * Copies the code of the block whose copy button was clicked. Returns true when the target was a copy button, so
 * the caller can stop handling the click.
 */
export function copyCodeBlock(target: unknown): boolean {
  const button = closest(target, '[data-cuppet-copy]');
  if (!button) return false;
  const code = closest(button, '.md-code-block')?.querySelector?.('pre code')?.textContent ?? '';
  const native = (window.cuppet?.native ?? {}) as unknown as CopyBridge;
  void (async () => {
    try {
      if (!native.copyText) throw new Error('clipboard unavailable');
      await native.copyText(code);
      flash(button, 'Copied', 'Code copied');
    } catch {
      flash(button, 'Failed', 'Copy failed');
    }
  })();
  return true;
}
