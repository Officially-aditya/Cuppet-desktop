import type { TranscriptItem, TranscriptTool } from './chat-transcript';

export type ToolKind = 'read' | 'search' | 'edit' | 'write' | 'command' | 'validate' | 'other';
export type WorkGroup = { id: string; type: 'work-group'; items: Exclude<TranscriptItem, { type: 'status' }>[] };

export function classifyTool(toolName: string): ToolKind {
  const name = toolName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[.:/]/).at(-1) ?? '';
  if (/(^|[_-])read($|[_-])/.test(name)) return 'read';
  if (/search|grep|find|explore|locate|glob/.test(name)) return 'search';
  if (/(^|[_-])(edit|patch|diff)($|[_-])/.test(name)) return 'edit';
  if (/(^|[_-])(write|create)($|[_-])/.test(name)) return 'write';
  if (/test|verify|validate|lint|check/.test(name)) return 'validate';
  if (name === 'bash' || /shell|terminal|command|exec/.test(name)) return 'command';
  return 'other';
}

export function liveThoughtLine(text: string): string {
  // Only inspect a short prefix: raw-thinking providers can stream very long blocks.
  const prefix = text.trimStart().slice(0, 512);
  const boldStart = prefix.indexOf('**');
  const boldEnd = boldStart >= 0 ? prefix.indexOf('**', boldStart + 2) : -1;
  if (boldStart >= 0 && boldEnd < 0) return '';
  const plain = (boldStart >= 0 ? prefix.slice(boldStart + 2, boldEnd) : prefix)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/gm, '')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.!?,:]|$)/g, '$1$2')
    .replace(/[`*~]/g, '')
    .trim();
  const line = (boldStart >= 0 ? plain : plain.match(/^.*?[.!?](?:\s|$)|^[^\r\n]+/)?.[0] ?? '')
    .replace(/\s+/g, ' ').trim();
  return line.length <= 140 ? line : '';
}

export function liveStatus(trace: readonly TranscriptItem[]): string {
  let thought: string | undefined;
  let running: TranscriptTool | undefined;
  let latestTool: TranscriptTool | undefined;
  for (let index = trace.length - 1; index >= 0; index--) {
    const item = trace[index];
    if (thought === undefined && item.type === 'reasoning') thought = item.text;
    if (!latestTool && item.type === 'tool') latestTool = item;
    if (!running && item.type === 'tool' && item.status === 'running') running = item;
    if (thought !== undefined && running) break;
  }
  return (thought && liveThoughtLine(thought))
    || (running && toolActivityLabel(running.tool, running.argumentsJson, running.status))
    || (thought === undefined && latestTool && toolActivityLabel(latestTool.tool, latestTool.argumentsJson, latestTool.status))
    || (thought !== undefined ? 'Thinking…' : 'Working…');
}

const SUMMARY_ORDER: ToolKind[] = ['command', 'edit', 'write', 'validate', 'read', 'search', 'other'];
const SUMMARY_WORDS: Record<ToolKind, [string, string]> = {
  command: ['Ran', 'command'], edit: ['Edited', 'file'], write: ['Wrote', 'file'],
  validate: ['Ran', 'check'], read: ['Read', 'file'], search: ['Performed', 'search'], other: ['Performed', 'other action'],
};
// Transcript tools are immutable. Reuse parsed targets while unrelated reasoning streams.
const toolSummaryCache = new WeakMap<TranscriptTool, { kind: ToolKind; targets: string[] }>();

export function summarizeTrace(trace: readonly TranscriptItem[]) {
  const counts: Record<ToolKind, number> = { read: 0, search: 0, edit: 0, write: 0, command: 0, validate: 0, other: 0 };
  const calls = { ...counts };
  const seen = { read: new Set<string>(), edit: new Set<string>(), write: new Set<string>() };
  let failed = 0;
  let running = 0;
  let total = 0;
  for (const item of trace) {
    if (item.type !== 'tool') continue;
    total++;
    if (item.status === 'error') { failed++; continue; }
    if (item.status === 'running') { running++; continue; }
    let summary = toolSummaryCache.get(item);
    if (!summary) {
      const kind = classifyTool(item.tool);
      summary = { kind, targets: kind === 'read' || kind === 'edit' || kind === 'write'
        ? toolTargets(item.tool, parseToolArguments(item.argumentsJson)) : [] };
      toolSummaryCache.set(item, summary);
    }
    const { kind, targets } = summary;
    calls[kind]++;
    if ((kind === 'read' || kind === 'edit' || kind === 'write') && targets.length) {
      for (const target of targets) {
        if (!seen[kind].has(target)) { seen[kind].add(target); counts[kind]++; }
      }
    } else counts[kind]++;
  }
  const kinds = SUMMARY_ORDER.filter((kind) => kind !== 'other' && counts[kind]);
  const clauses = kinds.slice(0, 2).map((kind) => {
    const [verb, noun] = SUMMARY_WORDS[kind];
    return `${verb} ${counts[kind]} ${noun}${counts[kind] === 1 ? '' : noun === 'search' ? 'es' : 's'}`;
  });
  const others = counts.other + kinds.slice(2).reduce((sum, kind) => sum + calls[kind], 0);
  if (others) clauses.push(`Performed ${others} other action${others === 1 ? '' : 's'}`);
  const label = clauses.map((clause, index) => index ? clause[0].toLowerCase() + clause.slice(1) : clause).join(' · ');
  return { label, counts, failed, running, total };
}

export function groupTrace(trace: readonly TranscriptItem[]) {
  const groups: (Exclude<TranscriptItem, TranscriptTool> | WorkGroup)[] = [];
  for (const item of [...trace].sort((a, b) => a.sequence - b.sequence)) {
    if (item.type === 'status' || (item.type === 'reasoning' && item.kind === 'commentary')) { groups.push(item); continue; }
    const previous = groups.at(-1);
    if (previous?.type === 'work-group') previous.items.push(item);
    else groups.push({ id: item.id, type: 'work-group', items: [item] });
  }
  return groups;
}

export function toolActivityLabel(toolName = '', argumentsJson = '{}', status: TranscriptTool['status']) {
  const args = parseToolArguments(argumentsJson);
  const normalizedTool = toolName.toLowerCase();
  const kind = classifyTool(toolName);
  const failed = status === 'error';
  const complete = status === 'complete';
  const phrase = (active: string, done: string, error: string) => failed ? error : complete ? done : active;
  const targets = toolTargets(toolName, args);
  const target = describeTargets(targets, args);
  const focus = toolExploreFocus(args);
  const command = toolCommand(args);

  if (kind === 'read') return target
    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)
    : phrase('Reading file…', 'Read file', 'Couldn’t read file');
  if (normalizedTool === 'cuppet_memory_search') return phrase('Searching memory…', 'Searched memory', 'Memory search failed');
  if (kind === 'search') return focus
    ? phrase(`Searching ${focus}…`, `Searched ${focus}`, `Search failed for ${focus}`)
    : phrase('Searching workspace…', 'Searched workspace', 'Workspace search failed');
  if (normalizedTool === 'tst_edit_batch') {
    if (String(args.action ?? '') === 'apply' && !target) return phrase('Applying edit batch…', 'Applied edit batch', 'Edit batch failed');
    return target ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`) : phrase('Editing files…', 'Edited files', 'Couldn’t edit files');
  }
  if (kind === 'edit') return target
    ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
    : phrase('Editing file…', 'Edited file', 'Couldn’t edit file');
  if (kind === 'write') return target
    ? phrase(`Writing ${target}…`, `Wrote ${target}`, `Couldn’t write ${target}`)
    : phrase('Writing file…', 'Wrote file', 'Couldn’t write file');
  if (kind === 'validate') return target
    ? phrase(`Validating ${target}…`, `Validated ${target}`, `Validation failed for ${target}`)
    : phrase('Running validation…', `${humanToolLabel(toolName)} passed`, `${humanToolLabel(toolName)} failed`);
  if (normalizedTool === 'cuppet_plan') return phrase('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (kind === 'command') return command
    ? phrase(`Running ${command}…`, `Ran ${command}`, `Command failed: ${command}`)
    : phrase('Running command…', 'Ran command', 'Command failed');
  if (normalizedTool === 'question') return phrase('Waiting for input…', 'Received input', 'Input request failed');

  const name = humanToolLabel(toolName);
  return phrase(`${name}…`, `${name} completed`, `${name} failed`);
}

function describeTargets(targets: string[], args: Record<string, unknown>) {
  if (!targets.length) return '';
  if (targets.length > 1) {
    const names = targets.slice(0, 3).map(targetName);
    if (targets.length <= 3) return names.join(', ');
    return `${targets.length} files · ${names.slice(0, 2).join(', ')} +${targets.length - 2}`;
  }
  const base = targetName(targets[0]);
  const range = toolLineRange(args);
  return range ? `${base} · ${range}` : base;
}

export function toolLineRange(args: Record<string, unknown>) {
  const start = Number(args.start_line ?? args.startLine ?? args.line_start ?? args.offset);
  const end = Number(args.end_line ?? args.endLine ?? args.line_end);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) return `lines ${start}–${end}`;
  if (Number.isFinite(start) && start > 0) return `from line ${start}`;
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0 && (args.path || args.file)) return `up to ${limit} lines`;
  return '';
}

export function toolCommand(args: Record<string, unknown>, compact = true) {
  const value = [args.command, args.cmd, args.script].find((item) => (typeof item === 'string' && item.trim()) || (Array.isArray(item) && item.length));
  if (value === undefined) return '';
  const raw = Array.isArray(value) ? value.map(String).join(' ') : String(value);
  const normalized = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!compact) return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
  return normalized.length > 54 ? `${normalized.slice(0, 51)}…` : normalized;
}

export function humanToolLabel(value: string) {
  const normalized = String(value || 'tool')
    .replace(/^cuppet[_-]runtime[_-]/, '')
    .replace(/^cuppet[_-]/, '')
    .replace(/^tst[_-]/, 'TST ')
    .replace(/^workspace[_-]/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return normalized ? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Tool';
}

export function toolTargets(toolName: string, args: Record<string, unknown>) {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (path && !values.includes(path)) values.push(path);
  };

  add(args.path);
  add(args.file);
  add(args.filename);
  add(args.file_path);
  add(args.filePath);
  add(args.filepath);
  add(args.target);
  if (Array.isArray(args.paths)) for (const value of args.paths) add(value);
  if (Array.isArray(args.files)) for (const value of args.files) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);
  if (Array.isArray(args.targets)) for (const value of args.targets) add(typeof value === 'string' ? value : (value as Record<string, unknown>)?.path);

  if (toolName === 'tst_read' || toolName === 'workspace_read') {
    add(args.path);
    for (const item of arrayRecords(args.reads)) add(item.path);
    for (const item of arrayRecords(args.targets)) add(item.path);
  } else if (toolName === 'tst_edit_batch') {
    for (const item of arrayRecords(args.operations)) {
      add(item.path);
      if (item.target && typeof item.target === 'object' && !Array.isArray(item.target)) add((item.target as Record<string, unknown>).path);
    }
  } else if (toolName === 'tst_validate') {
    for (const value of Array.isArray(args.paths) ? args.paths : []) add(value);
  } else if (toolName === 'workspace_edit' || toolName === 'workspace_write') {
    add(args.path);
  }
  return values.slice(0, 64);
}

export function toolExploreFocus(args: Record<string, unknown>) {
  const prefix = typeof args.prefix === 'string' ? args.prefix.trim() : '';
  if (prefix) return targetName(prefix);
  const query = [args.query, args.pattern, args.search, args.needle].find((value) => typeof value === 'string' && value.trim());
  if (typeof query === 'string') return compactActivityText(query);
  return '';
}

export function parseToolArguments(value: string) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function arrayRecords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
}

function targetName(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.split('/').filter(Boolean).at(-1) || normalized;
  return compactActivityText(name);
}

export function compactActivityText(value: string) {
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}
