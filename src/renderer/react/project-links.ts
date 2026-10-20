// Opening the links that appear in rendered chat markdown.
//
// The markdown renderer marks project file links with data-cuppet-project-file and web links with
// data-cuppet-external. React attaches the handlers declaratively (MarkdownContent and ChatLinkPreview), so
// nothing here observes or rewrites DOM that React owns.

type NativeBridge = {
  openExternal?: (href: string) => Promise<unknown>;
  openProjectFile?: (projectId: string, path: string) => Promise<unknown>;
};

type LinkLike = {
  closest?: (selector: string) => LinkLike | null;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  href?: string;
};

const LINK_SELECTOR = '[data-cuppet-project-file], [data-cuppet-external]';
const PROJECT_FILE_SELECTOR = '[data-cuppet-project-file]';

/** Drops a trailing :line, :line:column or :line-line range from a path reference. */
export function stripLineSuffix(value: string) {
  return String(value).trim().replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
}

/** Runs a native-bridge call, swallowing both synchronous throws and rejected promises. */
function attempt(call: () => unknown) {
  try { void Promise.resolve(call()).catch(() => undefined); } catch { /* the bridge is best effort */ }
}

function closestLink(target: unknown, selector: string): LinkLike | null {
  const node = target as LinkLike | null | undefined;
  return node && typeof node.closest === 'function' ? node.closest(selector) : null;
}

/** True when the event target is, or sits inside, a project file reference. */
export function isProjectFileTarget(target: unknown) {
  return closestLink(target, PROJECT_FILE_SELECTOR) !== null;
}

/**
 * Opens the web link or project file under `target`. Returns true when the target was a chat link, so the
 * caller can preventDefault (a project file anchor has href="#").
 */
export function openChatLink(projectId: string | null | undefined, target: unknown): boolean {
  const element = closestLink(target, LINK_SELECTOR);
  if (!element) return false;
  const native = (window.cuppet?.native ?? {}) as unknown as NativeBridge;

  if (element.hasAttribute('data-cuppet-external')) {
    const href = element.href || element.getAttribute('href') || '';
    if (href) attempt(() => native.openExternal?.(href));
    return true;
  }

  const path = element.getAttribute('data-cuppet-project-file');
  if (path && projectId) attempt(() => native.openProjectFile?.(projectId, stripLineSuffix(path)));
  return true;
}
