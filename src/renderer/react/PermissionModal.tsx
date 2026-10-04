import { useMemo, useState } from 'react';
import type { PermissionRequest } from '../types';

export function PermissionModal({ request, onResolve }: { request: PermissionRequest; onResolve: (reply: 'once' | 'always' | 'reject', enableAuto?: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const resources = request.resources ?? [];
  const resourceSummary = useMemo(() => summarizeResources(resources), [resources]);

  const run = async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    setBusy(true);
    try { await onResolve(reply, enableAuto); }
    finally { setBusy(false); }
  };

  return (
    <section
      className="permission-inline"
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
