import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PermissionRequest } from '../types';
import { plainLanguageSummary } from './command-summary';
import { requestLead, visibleResource } from './permission-display';
import { isUnsandboxed, useSandboxStatus } from './sandbox-status';

type Reply = 'once' | 'always' | 'reject';

export function PermissionModal({ request, onResolve }: { request: PermissionRequest; onResolve: (reply: Reply, enableAuto?: boolean) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const leadId = useId();
  const summaryId = useId();
  const moreId = useId();

  const resources = request.resources ?? [];
  // The whole request is shown, never a shortened copy. Characters that could make it look different from what
  // runs (bidirectional overrides, zero-width and control characters) are made visible.
  const shown = useMemo(() => resources.map(visibleResource), [resources]);
  const hiddenCount = shown.reduce((total, resource) => total + resource.hidden, 0);

  const isCommand = request.action === 'bash' && resources.length === 1;
  const isGitPush = request.action === 'git-push' && resources.length === 5;
  const lead = isGitPush ? 'Push this commit to the remote repository.' : requestLead(request.description, isCommand);
  // A short, deterministic description of what a command does. Informational only: the command above is what runs.
  const summary = useMemo(() => (isCommand ? plainLanguageSummary(String(resources[0])) : null), [isCommand, resources]);
  const hasSummary = !!summary && !!(summary.what || summary.headsUp || summary.note);
  // Without an OS sandbox the user's own permissions apply, so this prompt is the only control.
  const sandboxStatus = useSandboxStatus();
  const unsandboxed = request.action === 'bash' && isUnsandboxed(sandboxStatus);

  // Move focus into the panel so keyboard and screen-reader users land in it. Focus goes to the panel itself, not to
  // a button: a keypress meant for the composer (Enter, Space) must never be able to approve a command. When the
  // request is answered, focus goes back to whatever had it.
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const active = document.activeElement;
      if (previous instanceof HTMLElement && previous.isConnected && (!active || active === document.body)) previous.focus();
    };
  }, []);

  const run = async (reply: Reply, enableAuto = false) => {
    setBusy(true);
    try { await onResolve(reply, enableAuto); }
    finally { setBusy(false); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    // Escape closes the options first; with nothing open it rejects the request.
    if (moreOpen) { setMoreOpen(false); moreButtonRef.current?.focus(); return; }
    if (!busy) void run('reject');
  };

  return (
    <>
    <section
      ref={panelRef}
      className="permission-inline"
      role="alertdialog"
      aria-modal="false"
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={hasSummary ? `${leadId} ${summaryId}` : leadId}
      onKeyDown={onKeyDown}
    >
      <div className="permission-inline-copy">
        <strong id={titleId}>Permission required</strong>
        <span className="permission-inline-description" id={leadId}>{lead}</span>
      </div>

      {unsandboxed && (
        <p className="permission-inline-warning" role="note">
          <strong>No OS sandbox on this system.</strong>{' '}
          This command runs with your full user permissions, so your approval is the only control. Read it before you allow it.
        </p>
      )}

      {shown.length > 0 && (
        // Focusable so keyboard users can scroll a long command.
        <div className={`permission-inline-resources${isGitPush ? ' is-git-push' : ''}`} role="group" tabIndex={0} aria-label={isCommand ? 'Full command' : isGitPush ? 'Git push details' : `Requested resources (${shown.length})`}>
          {isGitPush ? (
            <dl className="permission-inline-details">
              {shown.map((resource, index) => (
                <div className="permission-inline-detail" key={index}>
                  <dt>{['Repository', 'Remote', 'Remote URL', 'Branch', 'Commit'][index]}</dt>
                  <dd><pre className="permission-inline-value">{resource.text}</pre></dd>
                </div>
              ))}
            </dl>
          ) : shown.map((resource, index) => <pre key={index} className="permission-inline-resource">{resource.text}</pre>)}
        </div>
      )}

      {hiddenCount > 0 && (
        <p className="permission-inline-hidden-note" role="note">
          This request contains {hiddenCount} hidden or non-printing character{hiddenCount === 1 ? '' : 's'}, shown above as {'\\uXXXX'} escapes.
        </p>
      )}

      <div className="permission-inline-actions">
        <button
          ref={moreButtonRef}
          type="button"
          className="permission-inline-button more"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          onClick={() => setMoreOpen((open) => !open)}
        >{moreOpen ? 'Fewer options' : 'More options'}</button>
        <button type="button" className="permission-inline-button" disabled={busy} onClick={() => void run('reject')}>Reject</button>
        <button type="button" className="permission-inline-button primary" disabled={busy} onClick={() => void run('once')}>Allow once</button>
      </div>

      {/* Always rendered so aria-controls has a target; the hidden attribute keeps it out of view and of the accessibility tree. */}
      <div className="permission-inline-more" id={moreId} role="group" aria-label="More approval options" hidden={!moreOpen}>
        <div className="permission-inline-option">
          <button type="button" className="permission-inline-button" disabled={busy} onClick={() => void run('always')}>Always this exact request</button>
          <span className="permission-inline-option-help">Stops asking for this same action on these same resources for the rest of this session. It is never a wildcard.</span>
        </div>
        {request.autoEligible && (
          <div className="permission-inline-option">
            <button type="button" className="permission-inline-button" disabled={busy} onClick={() => void run('once', true)}>Enable guarded auto</button>
            <span className="permission-inline-option-help">Allows this once and turns on guarded auto for this session. Eligible project actions that pass containment and sensitivity checks then run without asking.</span>
          </div>
        )}
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
