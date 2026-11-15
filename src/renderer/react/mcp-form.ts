import type { McpServer, McpServerStatus } from '../types';

// Pure helpers behind Settings → MCP, kept apart from the component so they can be tested without a DOM.

export type EnvRow = {
  key: number;
  name: string;
  value: string;
  /** A value for this name is already stored. The renderer is never given it, only told that it exists. */
  saved: boolean;
};

export type McpForm = {
  id: string | null;
  name: string;
  command: string;
  /** One argument per line, so paths with spaces and quotes need no escaping rules. */
  args: string;
  env: EnvRow[];
  enabled: boolean;
};

let nextRowKey = 1;
export function newEnvRow(name = '', saved = false): EnvRow {
  return { key: nextRowKey++, name, value: '', saved };
}

export function emptyForm(): McpForm {
  return { id: null, name: '', command: '', args: '', env: [], enabled: true };
}

export function formFromServer(server: McpServer): McpForm {
  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args.join('\n'),
    env: server.envKeys.map((name) => newEnvRow(name, true)),
    enabled: server.enabled,
  };
}

/**
 * The payload for `mcp.save`. In `env`, text sets a value and `null` keeps the one already stored, which is how an
 * existing secret survives an edit without ever being sent back to the renderer.
 */
export function payloadFromForm(form: McpForm): Record<string, unknown> {
  const env: Record<string, string | null> = {};
  for (const row of form.env) {
    const name = row.name.trim();
    if (!name) continue;
    env[name] = row.value !== '' ? row.value : row.saved ? null : '';
  }
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    command: form.command.trim(),
    args: form.args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    env,
    enabled: form.enabled,
  };
}

export type StatusPresentation = { label: string; tone: 'ready' | 'muted' | 'warning'; detail: string };

export function statusPresentation(server: Pick<McpServer, 'enabled' | 'status'>): StatusPresentation {
  const status = server.status;
  if (!server.enabled) return { label: 'Disabled', tone: 'muted', detail: '' };
  if (!status) return { label: 'Checking…', tone: 'muted', detail: '' };
  switch (status.state) {
    case 'ready':
      return { label: status.toolCount === 1 ? 'Running · 1 tool' : `Running · ${status.toolCount} tools`, tone: 'ready', detail: status.message };
    case 'starting':
      return { label: 'Starting…', tone: 'muted', detail: 'The first start can take a while if the server has to download packages.' };
    case 'error':
      return { label: 'Error', tone: 'warning', detail: status.message };
    case 'disabled':
      return { label: 'Disabled', tone: 'muted', detail: '' };
    default:
      return { label: 'Stopped', tone: 'muted', detail: status.message };
  }
}

/** A single readable line for the server list. Arguments are shown as given; nothing here is ever executed. */
export function commandLine(server: Pick<McpServer, 'command' | 'args'>): string {
  return [server.command, ...server.args].join(' ');
}

export function mergeStatuses(servers: McpServer[], statuses: McpServerStatus[]): McpServer[] {
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return servers.map((server) => ({ ...server, status: byId.get(server.id) ?? server.status }));
}

/** Electron prefixes main-process errors with "Error invoking remote method …"; users should only see the message. */
export function cleanErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '').trim() || 'Something went wrong.';
}
