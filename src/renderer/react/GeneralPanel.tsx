import { useCallback, useEffect, useState } from 'react';
import type { BrowserControlStatus } from '../types';
import { SelectControl } from './SelectControl';
import {
  readPermissionMode,
  readSendBehavior,
  writePermissionMode,
  writeSendBehavior,
  type PermissionMode,
  type SendBehavior,
} from './behavior-preferences';

export function GeneralPanel() {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readPermissionMode());
  const [sendBehavior, setSendBehavior] = useState<SendBehavior>(() => readSendBehavior());
  const [browserControl, setBrowserControl] = useState<BrowserControlStatus | null>(null);
  const [browserBusy, setBrowserBusy] = useState(false);

  const changePermissionMode = (value: string) => {
    const next: PermissionMode = value === 'full' ? 'full' : value === 'auto' ? 'auto' : 'default';
    setPermissionMode(next);
    writePermissionMode(next);
  };

  const changeSendBehavior = (value: string) => {
    const next: SendBehavior = value === 'steer' ? 'steer' : 'queue';
    setSendBehavior(next);
    writeSendBehavior(next);
  };

  const refreshBrowserControl = useCallback(async () => {
    try { setBrowserControl(await window.cuppet.integrations.browserControl.status()); }
    catch (error) {
      setBrowserControl({ available: false, running: false, connected: false, message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void refreshBrowserControl();
    const unsubscribe = window.cuppet.onEvent((event) => {
      if (event?.type === 'integration.browser-control.updated' && event.status) setBrowserControl(event.status);
    });
    return unsubscribe;
  }, [refreshBrowserControl]);

  useEffect(() => {
    if (!browserControl?.running || browserControl.connected) return;
    const timer = window.setInterval(() => void refreshBrowserControl(), 1_000);
    return () => window.clearInterval(timer);
  }, [browserControl?.connected, browserControl?.running, refreshBrowserControl]);

  const toggleBrowserControl = async () => {
    setBrowserBusy(true);
    try {
      const next = browserControl?.running
        ? await window.cuppet.integrations.browserControl.disconnect()
        : await window.cuppet.integrations.browserControl.connect();
      setBrowserControl(next);
    } catch (error) {
      setBrowserControl((current) => ({ ...current, message: error instanceof Error ? error.message : String(error) }));
    } finally { setBrowserBusy(false); }
  };

  const browserState = browserControl?.connected ? 'Connected' : browserControl?.running ? 'Waiting for Chrome' : browserControl?.available === false ? 'Unavailable' : browserControl ? 'Ready' : 'Checking…';
  const browserDescription = browserControl?.message || 'Connect the browserControl Chrome extension to give Cuppet a local browser MCP.';

  return <div className="general-settings-stack">
    <div className="settings-card general-settings-card">
      <div className="settings-card-heading">
        <div><h3>General behaviour</h3><p>Choose how Cuppet handles permissions and messages while it is working.</p></div>
      </div>
      <div className="settings-row general-settings-row">
        <div><strong>Permissions</strong><span>Default asks before protected actions. Auto approves web fetches and actions scoped to the active project. Full access removes permission prompts in project chats, while destructive deletion outside the active project stays blocked.</span></div>
        <div className="general-settings-control">
          <SelectControl
            ariaLabel="Permissions"
            value={permissionMode}
            onChange={changePermissionMode}
            options={[{ value: 'default', label: 'Default' }, { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full access' }]}
          />
        </div>
      </div>
      <div className="settings-row general-settings-row">
        <div><strong>Send message behaviour</strong><span>Choose what happens when you send another message while Cuppet is already working.</span></div>
        <div className="general-settings-control">
          <SelectControl
            ariaLabel="Send message behaviour"
            value={sendBehavior}
            onChange={changeSendBehavior}
            options={[{ value: 'queue', label: 'Queue' }, { value: 'steer', label: 'Steer' }]}
          />
        </div>
      </div>
    </div>

    <div className="settings-card general-settings-card integrations-card">
      <div className="settings-card-heading">
        <div><h3>Integrations</h3><p>Connect local tools that Cuppet can use while it works. Mention @browserControl in a message to expose Chrome to that turn.</p></div>
      </div>
      <div className="settings-row general-settings-row integration-row">
        <div>
          <div className="integration-title-row"><strong>Chrome</strong><span className={`settings-status-pill compact${browserControl?.connected ? '' : ' muted'}`}>{browserState}</span></div>
          <span>browserControl · {browserDescription}</span>
        </div>
        <div className="integration-actions">
          <button
            type="button"
            className={browserControl?.running ? 'ghost-button settings-action-button' : 'primary-button settings-action-button'}
            disabled={browserBusy || browserControl === null || (!browserControl.running && browserControl.available === false)}
            onClick={() => void toggleBrowserControl()}
          >{browserBusy ? 'Working…' : browserControl?.running ? 'Disconnect' : 'Connect Chrome'}</button>
        </div>
      </div>
      {browserControl?.running && !browserControl.connected && <p className="general-settings-note">If Chrome does not connect automatically, open the browserControl extension once. It will discover Cuppet on localhost and reconnect locally.</p>}
    </div>
  </div>;
}
