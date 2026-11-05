import { useEffect, useRef, useState } from 'react';
import type { SandboxStatus } from '../types';
import { CUPPET_LOGO_URL } from './brand';
import { isUnsandboxed, useSandboxStatus } from './sandbox-status';
import { useModalBehavior } from './use-modal-behavior';

// Opened from the native Help menu. These pages explain how Cuppet works and have nothing to configure,
// so they live here instead of in Settings.
export type HelpTopic = 'security' | 'privacy' | 'about';

const HELP_META: Record<HelpTopic, [string, string]> = {
  security: ['Security & Sandbox', 'How Cuppet contains commands, and whether the OS sandbox is active on this computer.'],
  privacy: ['Data & privacy', 'Understand where desktop data and credentials live.'],
  about: ['About', 'Desktop runtime and build information.'],
};

type Props = {
  topic: HelpTopic;
  onTopic: (topic: HelpTopic) => void;
  onClose: () => void;
};

export function HelpModal({ topic, onTopic, onClose }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalBehavior(dialogRef, onClose);
  const sandboxStatus = useSandboxStatus();
  const [title, description] = HELP_META[topic] ?? HELP_META.security;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="react-modal settings-hub-dialog react-settings-hub" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-hub-shell">
          <aside className="settings-hub-sidebar">
            <div className="settings-hub-brand"><img className="settings-hub-mark" src={CUPPET_LOGO_URL} alt="" aria-hidden="true" /><div><strong>Help</strong><span>Cuppet</span></div></div>
            <nav className="settings-hub-nav" aria-label="Help topics">
              {(Object.entries(HELP_META) as [HelpTopic, [string, string]][]).map(([id, [label]]) => <button type="button" key={id} className={topic === id ? 'active' : ''} onClick={() => onTopic(id)}>{label}</button>)}
            </nav>
          </aside>
          <div className="settings-hub-main">
            <header className="settings-hub-header"><div><h2 id="help-title">{title}</h2><p>{description}</p></div><button type="button" className="icon-button settings-close-button" aria-label="Close" onClick={onClose}>×</button></header>
            <div className="settings-hub-content">
              {topic === 'security' && <SecurityPanel sandboxStatus={sandboxStatus} />}
              {topic === 'privacy' && <PrivacyPanel />}
              {topic === 'about' && <AboutPanel />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SecurityPanel({ sandboxStatus }: { sandboxStatus: SandboxStatus | null }) {
  const driverLabel = sandboxStatus
    ? sandboxStatus.driverName === 'mac-seatbelt'
      ? 'macOS Seatbelt (sandbox-exec)'
      : sandboxStatus.driverName === 'linux-bwrap'
        ? 'Linux Bubblewrap (bwrap)'
        : sandboxStatus.available
          ? sandboxStatus.driverName
          : 'None (Unsandboxed)'
    : 'Checking…';

  const isEnforced = Boolean(sandboxStatus?.available);
  // Without a sandbox, macOS and Linux refuse to run commands; any other platform runs them with the user's own permissions.
  const unsandboxed = isUnsandboxed(sandboxStatus);

  return (
    <div className="settings-card">
      <div className="settings-card-heading">
        <div>
          <h3>Kernel Sandbox Containment</h3>
          <p>Local OS-level security boundaries applied to child commands and tools executed by Cuppet.</p>
        </div>
        <span className={`settings-status-pill${isEnforced ? '' : ' muted'}`}>
          {isEnforced ? 'Enforced' : sandboxStatus ? 'Inactive' : 'Checking…'}
        </span>
      </div>

      {unsandboxed && (
        <div className="settings-callout" role="note">
          <strong>No OS sandbox on this system</strong>
          <span>Shell commands run with your full user permissions, so the approval prompt is the only control. Read each command before you allow it.</span>
        </div>
      )}

      <div className="settings-row">
        <div>
          <strong>Sandboxing Engine</strong>
          <span>{driverLabel}</span>
        </div>
        <span className="settings-value">{isEnforced ? 'Active' : 'Not Active'}</span>
      </div>

      <div className="settings-row">
        <div>
          <strong>File Write Confinement</strong>
          <span>Restricted to project root and temporary directories. Modification of system or parent paths is blocked.</span>
        </div>
        <span className="settings-value">{isEnforced ? 'Project Root' : 'Unconfined'}</span>
      </div>

      <div className="settings-row">
        <div>
          <strong>Credential & Keychain Protection</strong>
          <span>Strictly blocks child process reads to sensitive locations: ~/.ssh, ~/.aws, ~/.gnupg, and Keychain files.</span>
        </div>
        <span className="settings-value">{sandboxStatus?.credentialProtection ? 'Protected' : 'Standard'}</span>
      </div>

      <div className="settings-row">
        <div>
          <strong>Environment Sanitization</strong>
          <span>Child processes receive a scrubbed environment allowlist. Cloud API keys, auth tokens, and sensitive env variables are automatically stripped.</span>
        </div>
        <span className="settings-value">Always Active</span>
      </div>
    </div>
  );
}

function PrivacyPanel() {
  return <div className="settings-card"><div className="settings-card-heading"><div><h3>Data & privacy</h3><p>How Cuppet keeps desktop data and credentials on this computer.</p></div></div>
    <div className="settings-row"><div><strong>Conversation storage</strong><span>Desktop conversations and project state are stored locally.</span></div><span className="settings-value">Local</span></div>
    <div className="settings-row"><div><strong>Provider credentials</strong><span>API keys use the operating system secure credential store when available. Codex OAuth remains owned by Codex.</span></div><span className="settings-value">On device</span></div>
    <div className="settings-row"><div><strong>Remote control</strong><span>The desktop remains authoritative; provider credentials are not sent to paired devices.</span></div><span className="settings-value">Opt-in</span></div>
  </div>;
}

function platformLabel(platform: string | undefined) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform || 'Unknown';
}

function AboutPanel() {
  const [version, setVersion] = useState('Checking…');
  useEffect(() => {
    let live = true;
    void Promise.resolve(window.cuppet?.native?.appVersion?.()).then(
      (next) => { if (live) setVersion(next || 'Unknown'); },
      () => { if (live) setVersion('Unknown'); },
    );
    return () => { live = false; };
  }, []);

  return <div className="settings-card about-card"><div className="about-brand"><img src={CUPPET_LOGO_URL} alt="Cuppet" /><div><h3>Cuppet Desktop</h3><p>Independent local agent runtime for projects, conversations, tools, and Remote.</p></div></div>
    <div className="settings-row"><div><strong>Version</strong><span>Include this when reporting a problem.</span></div><span className="settings-value">{version}</span></div>
    <div className="settings-row"><div><strong>Platform</strong><span>The operating system Cuppet is running on.</span></div><span className="settings-value">{platformLabel(window.cuppet?.native?.platform)}</span></div>
  </div>;
}
