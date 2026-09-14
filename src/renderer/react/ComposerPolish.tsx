import { useEffect } from 'react';

const STATE_CLASSES = [
  'composer-state-focused',
  'composer-state-multiline',
  'composer-state-attachments',
  'composer-state-context',
  'composer-state-palette',
  'composer-state-running',
  'composer-state-pending',
  'composer-state-expanded-control',
  'composer-state-compact',
] as const;

export function ComposerPolish() {
  useEffect(() => {
    let frame = 0;

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    };

    const sync = () => {
      const wrap = document.querySelector<HTMLElement>('.react-composer-wrap');
      const composer = document.querySelector<HTMLElement>('.react-composer');
      const messages = document.querySelector<HTMLElement>('.react-messages');
      const textarea = composer?.querySelector<HTMLTextAreaElement>('textarea');
      if (!wrap || !composer || !textarea) return;

      const focused = composer.contains(document.activeElement);
      const hasValue = Boolean(textarea.value.trim());
      const multiline = textarea.value.includes('\n') || textarea.scrollHeight > 72;
      const hasAttachments = Boolean(composer.querySelector('.composer-attachment'));
      const hasContext = Boolean(composer.querySelector('.composer-integration-chip'));
      const hasPalette = Boolean(wrap.querySelector('.react-command-palette, .integration-mention-palette'));
      const running = Boolean(composer.querySelector('.composer-pause-button'));
      const expandedControl = Boolean(composer.querySelector('.model-picker.open, .cuppet-select.open'));
      const pending = Boolean(document.querySelector('.permission-inline, .modal-priority .question-fields'));

      const maxScroll = messages ? Math.max(0, messages.scrollHeight - messages.clientHeight) : 0;
      const distanceFromBottom = messages ? Math.max(0, maxScroll - messages.scrollTop) : 0;
      const scrolledHistory = maxScroll > 96 && distanceFromBottom > 140;

      const compact = scrolledHistory
        && !focused
        && !hasValue
        && !multiline
        && !hasAttachments
        && !hasContext
        && !hasPalette
        && !expandedControl
        && !pending;

      const states: Record<(typeof STATE_CLASSES)[number], boolean> = {
        'composer-state-focused': focused,
        'composer-state-multiline': multiline,
        'composer-state-attachments': hasAttachments,
        'composer-state-context': hasContext,
        'composer-state-palette': hasPalette,
        'composer-state-running': running,
        'composer-state-pending': pending,
        'composer-state-expanded-control': expandedControl,
        'composer-state-compact': compact,
      };

      for (const name of STATE_CLASSES) {
        wrap.classList.toggle(name, states[name]);
      }

      const state = pending
        ? 'pending'
        : compact
          ? 'compact'
          : running
            ? 'running'
            : focused || hasValue || multiline || hasAttachments || hasContext || hasPalette || expandedControl
              ? 'active'
              : 'resting';
      if (wrap.dataset.composerState !== state) wrap.dataset.composerState = state;
    };

    const observerRoot = document.getElementById('root') ?? document.body;
    const observer = new MutationObserver(schedule);
    observer.observe(observerRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.matches('.react-messages')) schedule();
    };

    document.addEventListener('focusin', schedule, true);
    document.addEventListener('focusout', schedule, true);
    document.addEventListener('input', schedule, true);
    document.addEventListener('change', schedule, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', schedule);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('focusin', schedule, true);
      document.removeEventListener('focusout', schedule, true);
      document.removeEventListener('input', schedule, true);
      document.removeEventListener('change', schedule, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return null;
}
