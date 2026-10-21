import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandDefinition, CommandResult, Session } from '../types';
import type { ContextUsage } from './chat-transcript';
import { executePaletteAction } from './palette-actions';

const BROWSERCONTROL_MENTION = '@browserControl';
type Props = {
  value: string;
  setValue: (next: string | ((current: string) => string)) => void;
  commands: CommandDefinition[];
  session: Session | null;
  mode: 'plan' | 'build';
  composerKey: string;
  contextUsage?: ContextUsage;
  focusComposer: () => void;
};

export function useChatPalette({ value, setValue, commands, session, mode, composerKey, contextUsage, focusComposer }: Props) {
  const [selected, setSelected] = useState(0);
  const [commandResult, setCommandResult] = useState<CommandResult | null>(null);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const composerRef = useRef({ key: composerKey, value });
  composerRef.current = { key: composerKey, value };
  const palette = useMemo(() => {
    if (dismissedValue === value) return [];
    const query = currentSlashQuery(value);
    if (query === null) return [];
    return commands.filter((item) => {
      if (item.paletteOnly) return !query || [item.title, item.description, item.id].filter(Boolean).join(' ').toLowerCase().includes(query);
      return !query || [item.slash, item.title, item.description, ...(item.aliases ?? [])].filter(Boolean).join(' ').toLowerCase().includes(query);
    }).slice(0, 16);
  }, [commands, value, dismissedValue]);
  const integrationMentionQuery = currentIntegrationMentionQuery(value);
  const browserControlMentioned = hasBrowserControlMention(value);

  useEffect(() => setSelected(0), [value, composerKey]);


  useEffect(() => { setCommandResult(null); setDismissedValue(null); }, [composerKey]);
  const choose = async (item: CommandDefinition) => {
    if (item.paletteOnly) {
      if (item.requiresSession && !session) return;
      let result: CommandResult | null;
      try { result = await executePaletteAction(item, session?.id ?? null, mode); }
      catch (error) {
        // A failed action is shown as one, in the same place a successful result appears.
        result = { id: item.id, slash: item.title || item.slash, error: true, presentation: error instanceof Error ? error.message : String(error) };
      }
      if (composerRef.current.key !== composerKey || composerRef.current.value !== value) return;
      setValue('');
      if (result) setCommandResult(result);
      focusComposer();
      return;
    }
    if (!item.slash) return;
    setValue(`/${item.slash}${item.takesText ? ' ' : ''}`);
    focusComposer();
  };


  const chooseBrowserControl = () => {
    setValue((current) => insertBrowserControlMention(current));
    focusComposer();
  };
  const handlePaletteKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dismissedValue !== value && integrationMentionQuery !== null && browserControlMentionMatches(integrationMentionQuery)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setValue((current) => current.replace(/@[^\s]*$/, ''));
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !hasBrowserControlMention(value)) {
        event.preventDefault();
        chooseBrowserControl();
        return true;
      }
    }
    if (palette.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((current) => (current + 1) % palette.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((current) => (current - 1 + palette.length) % palette.length);
        return true;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const item = palette[selected] ?? palette[0];
        if (item) void choose(item);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedValue(value);
        return true;
      }
    }
    return false;
  };

  const paletteView = <>
    {commandResult && <CommandResultView result={commandResult} contextUsage={contextUsage} onDismiss={() => setCommandResult(null)} />}
    {dismissedValue !== value && integrationMentionQuery !== null && browserControlMentionMatches(integrationMentionQuery) && !browserControlMentioned && <IntegrationMentionPalette onChoose={chooseBrowserControl} />}
    {palette.length > 0 && <CommandPalette items={palette} selected={selected} sessionAvailable={Boolean(session)} contextUsage={contextUsage} onChoose={choose} />}
  </>;
  return { setCommandResult, browserControlMentioned, handlePaletteKey, paletteView };
}

function IntegrationMentionPalette({ onChoose }: { onChoose: () => void }) {
  return (
    <div className="command-palette react-command-palette integration-mention-palette" role="listbox" aria-label="Cuppet integrations">
      <button type="button" className="command-option selected" role="option" aria-selected="true" onMouseDown={(event) => event.preventDefault()} onClick={onChoose}>
        <div className="command-name">{BROWSERCONTROL_MENTION}</div>
        <div className="command-description">Use your connected Chrome through browserControl for this turn.</div>
        <div className="command-meta">integration · optional mention</div>
      </button>
    </div>
  );
}

function ContextUsageBar({ usage }: { usage?: ContextUsage }) {
  const percent = usage ? Math.min(100, usage.usedTokens / usage.windowTokens * 100) : 0;
  const percentLabel = percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1).replace(/\.0$/, '');
  const label = usage
    ? `${usage.estimated ? '≈ ' : ''}${usage.usedTokens.toLocaleString()} / ${usage.windowTokens.toLocaleString()} tokens · ${percentLabel}%${usage.estimated ? ' estimated' : ''}`
    : 'Usage unavailable';
  return (
    <div className="command-context-usage">
      <div className="command-context-label"><span>Context window · last request</span><span>{label}</span></div>
      <div className="command-context-track" role="progressbar" aria-label="Current chat context window" aria-valuemin={0} aria-valuemax={usage?.windowTokens} aria-valuenow={usage ? Math.min(usage.usedTokens, usage.windowTokens) : undefined} aria-valuetext={label}>
        <span className="command-context-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function CommandPalette({ items, selected, sessionAvailable, contextUsage, onChoose }: { items: CommandDefinition[]; selected: number; sessionAvailable: boolean; contextUsage?: ContextUsage; onChoose: (item: CommandDefinition) => void | Promise<void> }) {
  return (
    <div className="command-palette react-command-palette" role="listbox" aria-label="Cuppet commands">
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          className={`command-option${index === selected ? ' selected' : ''}`}
          role="option"
          aria-selected={index === selected}
          disabled={Boolean(item.requiresSession && !sessionAvailable && item.paletteOnly)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void onChoose(item)}
        >
          <div className="command-name">{item.slash ? `/${item.slash}` : item.title || item.id}</div>
          <div className="command-description">{item.description}</div>
          {item.id === 'compact' && <ContextUsageBar usage={contextUsage} />}
          <div className="command-meta">{item.paletteOnly ? 'action' : item.requiresSession ? 'session' : 'global'}{item.aliases?.length ? ` · aliases: ${item.aliases.map((alias) => `/${alias}`).join(', ')}` : ''}</div>
        </button>
      ))}
    </div>
  );
}

function CommandResultView({ result, contextUsage, onDismiss }: { result: CommandResult; contextUsage?: ContextUsage; onDismiss: () => void }) {
  const label = result.slash || result.id || 'Command';
  const summary = result.presentation || summarize(result.result);
  const text = summary.trim() === 'Command completed.' ? `${label} finished with no additional output.` : summary;
  return (
    <div className={`command-result react-command-result${result.error ? ' error' : ''}`} role={result.error ? 'alert' : 'status'}>
      <strong>{label}</strong>
      <div className="command-result-copy">
        <span>{text}</span>
        {result.id === 'compact' && <ContextUsageBar usage={contextUsage} />}
      </div>
      <button type="button" className="text-button" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

function currentIntegrationMentionQuery(value: string) {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1].toLowerCase() : null;
}
function browserControlMentionMatches(query: string) {
  return !query || 'browsercontrol'.startsWith(query) || 'chrome'.startsWith(query);
}
function hasBrowserControlMention(value: string) {
  return /(^|\s)@browsercontrol(?=$|\s|[.,!?;:])/i.test(value);
}
function insertBrowserControlMention(value: string) {
  if (hasBrowserControlMention(value)) return value;
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) return `${value}${value && !/\s$/.test(value) ? ' ' : ''}${BROWSERCONTROL_MENTION} `;
  const prefix = value.slice(0, match.index);
  const spacer = match[0].startsWith(' ') || match[0].startsWith('\n') || !prefix ? match[0].slice(0, 1) : ' ';
  return `${prefix}${spacer}${BROWSERCONTROL_MENTION} `;
}
export function removeBrowserControlMention(value: string) {
  return value.replace(/(^|\s)@browsercontrol(?=$|\s|[.,!?;:])/ig, '$1').replace(/[ \t]{2,}/g, ' ').trimStart();
}

function currentSlashQuery(value: string) {
  if (!value.startsWith('/') || value.includes('\n')) return null;
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) return null;
  return value.slice(1).toLowerCase();
}

function exactSlash(value: string, item: CommandDefinition) {
  const trimmed = value.trim().toLowerCase();
  return trimmed === `/${item.slash}` || item.aliases?.some((alias) => trimmed === `/${alias}`);
}


function summarize(value: CommandResult['result']) {
  if (value == null) return 'Command completed.';
  if (typeof value === 'string') return value.slice(0, 600);
  if (typeof value === 'boolean') return value ? 'Enabled.' : 'Disabled.';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.reason === 'string') return record.reason.slice(0, 600);
    if (typeof record.message === 'string') return record.message.slice(0, 600);
    if (typeof record.mode === 'string') return `Mode: ${record.mode}`;
    if (typeof record.enabled === 'boolean') return record.enabled ? 'Enabled.' : 'Disabled.';
    return 'Command completed.';
  }
  return String(value).slice(0, 600);
}

