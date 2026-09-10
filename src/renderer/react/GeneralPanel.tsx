import { useState } from 'react';
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

  const changePermissionMode = (value: string) => {
    const next: PermissionMode = value === 'auto' ? 'auto' : 'default';
    setPermissionMode(next);
    writePermissionMode(next);
  };

  const changeSendBehavior = (value: string) => {
    const next: SendBehavior = value === 'steer' ? 'steer' : 'queue';
    setSendBehavior(next);
    writeSendBehavior(next);
  };

  return <div className="settings-card general-settings-card">
    <div className="settings-card-heading">
      <div><h3>General behaviour</h3><p>Choose how Cuppet handles permissions and messages while it is working.</p></div>
    </div>
    <div className="settings-row general-settings-row">
      <div><strong>Permissions</strong><span>Default asks before protected actions. Auto enables guarded automatic approval for eligible actions in project chats.</span></div>
      <div className="general-settings-control">
        <SelectControl
          ariaLabel="Permissions"
          value={permissionMode}
          onChange={changePermissionMode}
          options={[{ value: 'default', label: 'Default' }, { value: 'auto', label: 'Auto' }]}
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
  </div>;
}
