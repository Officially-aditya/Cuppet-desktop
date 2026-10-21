// Helpers for showing a permission request faithfully: the whole command, with nothing hidden.

// Characters that can make a command look different from what runs: control characters (including a bare carriage
// return, which can overwrite the visible line), soft hyphens, zero-width and bidirectional controls, line and
// paragraph separators, and invisible tag characters. Tab and newline are ordinary layout and stay as they are.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

export type VisibleResource = { text: string; hidden: number };

/** The resource text to display, with every hidden character replaced by a visible \uXXXX escape. */
export function visibleResource(value: unknown): VisibleResource {
  let hidden = 0;
  const text = String(value ?? '').replace(HIDDEN, (char) => {
    hidden++;
    const code = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
    return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
  });
  return { text, hidden };
}

/**
 * The line that introduces a request. For a command the whole command is shown in its own block, so the shortened
 * copy the runtime appends to the description ("Run shell command in project: <first 300 characters>") is dropped
 * instead of repeating the start of the command a second time.
 */
export function requestLead(description: string | undefined, isCommand: boolean) {
  const text = String(description ?? '').trim();
  if (!text) return isCommand ? 'Cuppet wants to run a command.' : 'Cuppet wants to perform a protected action.';
  return isCommand ? text.replace(/:\s[\s\S]*$/, '') : text;
}
