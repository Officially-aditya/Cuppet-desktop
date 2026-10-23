// Validation for renderer-supplied prompt attachments and command input. Kept free of Electron
// imports so the exact rules can be unit-tested.

// Same ceiling the IPC contract allows for a normal prompt (see 'text' in shared/ipc-contract.mjs).
export const MAX_PROMPT_TEXT = 2_000_000;
const MAX_COMMAND_TEXT = 8192;
const STEER_COMMAND_ID = 'cuppet.steer.interrupt';

export function validateAttachments(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 16).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 240) : '';
    const mime = typeof value.mime === 'string' ? value.mime.trim().slice(0, 128) : '';
    const path = typeof value.path === 'string' ? value.path.trim().slice(0, 512) : '';
    const rawDataUrl = typeof value.dataUrl === 'string' ? value.dataUrl.trim() : '';
    const validDataUrl = rawDataUrl.length > 0 && rawDataUrl.length <= 20 * 1024 * 1024 && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(rawDataUrl) ? rawDataUrl : '';
    if (!name && !path && !validDataUrl) return [];
    return [{ ...(name ? { name } : {}), ...(mime ? { mime } : {}), ...(path ? { path } : {}), ...(validDataUrl ? { dataUrl: validDataUrl } : {}), ...(Number.isFinite(value.size) ? { size: Math.max(0, Math.trunc(value.size)) } : {}) }];
  });
}

/**
 * @param {unknown} value the structured `input` of a command
 * @param {string} [commandId] the command being run. A steered prompt is a user prompt, so it is not
 *   cut to the short limit that applies to command arguments.
 */
export function validateCommandInput(value, commandId = '') {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const textLimit = commandId === STEER_COMMAND_ID ? MAX_PROMPT_TEXT : MAX_COMMAND_TEXT;
  return {
    ...(typeof record.key === 'string' ? { key: record.key.trim().slice(0, 240) } : {}),
    ...(typeof record.value === 'string' ? { value: record.value.trim().slice(0, 4000) } : {}),
    ...(typeof record.text === 'string' ? { text: record.text.trim().slice(0, textLimit) } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: validateAttachments(record.attachments) } : {}),
    ...(['session', 'project', 'global'].includes(record.scope) ? { scope: record.scope } : {}),
    ...(['plan', 'build'].includes(record.mode) ? { mode: record.mode } : {}),
    ...(record.pinned === true ? { pinned: true } : {}),
  };
}
