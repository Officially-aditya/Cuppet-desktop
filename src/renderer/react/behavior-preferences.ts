export type PermissionMode = 'default' | 'auto';
export type SendBehavior = 'queue' | 'steer';

export const PREF_PERMISSION_MODE = 'cuppet.desktop.pref.permissions';
export const PREF_SEND_BEHAVIOR = 'cuppet.desktop.pref.send-behavior';
export const GENERAL_SETTINGS_EVENT = 'cuppet:general-settings';

export function readPermissionMode(): PermissionMode {
  return localStorage.getItem(PREF_PERMISSION_MODE) === 'auto' ? 'auto' : 'default';
}

export function readSendBehavior(): SendBehavior {
  return localStorage.getItem(PREF_SEND_BEHAVIOR) === 'steer' ? 'steer' : 'queue';
}

export function writePermissionMode(value: PermissionMode) {
  localStorage.setItem(PREF_PERMISSION_MODE, value);
  notifyGeneralSettings();
}

export function writeSendBehavior(value: SendBehavior) {
  localStorage.setItem(PREF_SEND_BEHAVIOR, value);
  notifyGeneralSettings();
}

function notifyGeneralSettings() {
  window.dispatchEvent(new Event(GENERAL_SETTINGS_EVENT));
}
