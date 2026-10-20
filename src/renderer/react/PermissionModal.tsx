import { useId, useMemo, useState } from 'react';
import type { PermissionRequest } from '../types';
import { plainLanguageSummary } from './command-summary';

export function PermissionModal({ request, onResolve }: { request: PermissionRequest; onResolve: (reply: 'once' | 'always' | 'reject', enableAuto?: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const resources = request.resources ?? [];
  const resourceSummary = useMemo(() => summarizeResources(resources), [resources]);
  // A short, deterministic description of what a command does. Informational only: the command above is what runs.
  const isCommand = request.action === 'bash' && resources.length === 1;
  const summary = useMemo(() => (isCommand ? plainLanguageSummary(String(resources[0])) : null), [isCommand, resources]);
  const hasSummary = !!summary && !!(summary.what || summary.headsUp || summary.note);
  const summaryId = useId();

  const run = async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    setBusy(true);
    try { await onResolve(reply, enableAuto); }
    finally { setBusy(false); }
  };

  return (
    <>
    <section
      className="permission-inline"
      role="alert"
      aria-labelledby="permission-title"
      aria-describedby={hasSummary ? summaryId : undefined}
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
    {hasSummary && summary && (
      <p className="permission-summary" id={summaryId}>
        <span className="permission-summary-label">What it does</span>{' '}
        {summary.what && <span>{summary.what}</span>}{' '}
        {summary.headsUp && <span className="permission-summary-heads-up">{summary.headsUp}</span>}{' '}
        {summary.note && <span>{summary.note}</span>}
      </p>
    )}
    </>
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
