import { useLayoutEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PermissionRequest } from '../types';

type Anchor = { left: number; width: number; bottom: number };

export function PermissionModal({ request, onResolve }: { request: PermissionRequest; onResolve: (reply: 'once' | 'always' | 'reject', enableAuto?: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const resources = request.resources ?? [];
  const resourceSummary = useMemo(() => summarizeResources(resources), [resources]);

  useLayoutEffect(() => {
    const composer = document.querySelector<HTMLElement>('.react-composer');
    const mainPane = document.querySelector<HTMLElement>('.react-main-pane');
    if (!composer) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = composer.getBoundingClientRect();
        setAnchor({
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)),
        });
      });
    };

    const resize = new ResizeObserver(measure);
    resize.observe(composer);
    if (mainPane) resize.observe(mainPane);
    window.addEventListener('resize', measure);
    measure();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const run = async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    setBusy(true);
    try { await onResolve(reply, enableAuto); }
    finally { setBusy(false); }
  };

  const style: CSSProperties | undefined = anchor
    ? { left: anchor.left, width: anchor.width, bottom: anchor.bottom }
    : undefined;

  return (
    <section
      className={`permission-inline${anchor ? ' anchored' : ''}`}
      style={style}
      role="alert"
      aria-labelledby="permission-title"
    >
      <div className="permission-inline-copy">
        <strong id="permission-title">Permission required</strong>
        <span className="permission-inline-description">{request.description || 'Cuppet wants to perform a protected action.'}</span>
        {resourceSummary && <span className="permission-inline-resource" title={resources.join('\n')}>{resourceSummary}</span>}
      </div>
      <div className="permission-inline-actions">
        <button type="button" className="permission-inline-button" disabled={busy} onClick={() => void run('reject')}>Deny</button>
        {request.autoEligible && (
          <button
            type="button"
            className="permission-inline-button"
            aria-label="Enable guarded auto"
            title="Enable guarded auto for eligible project actions"
            disabled={busy}
            onClick={() => void run('once', true)}
          >Auto</button>
        )}
        <button
          type="button"
          className="permission-inline-button"
          title="Always allow this exact request"
          disabled={busy}
          onClick={() => void run('always')}
        >Always</button>
        <button type="button" className="permission-inline-button primary" disabled={busy} onClick={() => void run('once')}>Allow</button>
      </div>
    </section>
  );
}

function summarizeResources(resources: string[]) {
  const cleaned = resources.map((value) => String(value).trim()).filter(Boolean);
  if (!cleaned.length) return '';
  if (cleaned.length === 1) return compact(cleaned[0]);
  return `${compact(cleaned[0])} + ${cleaned.length - 1} more`;
}

function compact(value: string) {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized.length > 82 ? `${normalized.slice(0, 79)}…` : normalized;
}
