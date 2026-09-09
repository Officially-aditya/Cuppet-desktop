import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodexModelCatalog, ProviderSettings } from '../types';

type ModelOption = {
  id: string;
  label: string;
  description?: string;
};

type Props = {
  disabled?: boolean;
};

const EMPTY_CODEX: CodexModelCatalog = { available: false, models: [], defaultModel: null };

export function ModelPicker({ disabled = false }: Props) {
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [codex, setCodex] = useState<CodexModelCatalog>(EMPTY_CODEX);
  const [customModel, setCustomModel] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    const next = await window.cuppet.settings.get();
    setSettings(next);
    const providerID = next.primary?.providerID || next.providerID || '';
    if (providerID === 'codex') {
      const catalog = await window.cuppet.codexAuth.models();
      setCodex(catalog);
      if (catalog.error) setError(catalog.error);
    } else {
      setCodex(EMPTY_CODEX);
    }
    return next;
  };

  useEffect(() => {
    void refresh().catch((value) => setError(message(value)));
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const providerID = settings?.primary?.providerID || settings?.providerID || '';
  const providerPreset = settings?.presets?.find((item) => item.id === providerID);
  const providerLabel = providerPreset?.label || providerID || 'Provider';
  const configuredModel = settings?.primary?.modelID || '';

  const options = useMemo<ModelOption[]>(() => {
    if (providerID === 'codex') {
      const dynamic = codex.models.map((model) => ({
        id: model.id,
        label: model.label || model.id,
        description: model.description,
      }));
      const defaultModel = codex.defaultModel;
      const defaultEntry = defaultModel ? dynamic.find((item) => item.id === defaultModel) : null;
      const special: ModelOption = {
        id: 'codex-default',
        label: defaultEntry ? `${defaultEntry.label} · Default` : 'Codex default',
        description: 'Follow the default model selected by your Codex account.',
      };
      return [special, ...dynamic];
    }

    const output: ModelOption[] = [];
    const seen = new Set<string>();
    const add = (id?: string, label?: string, description?: string) => {
      const value = String(id ?? '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      output.push({ id: value, label: label || value, ...(description ? { description } : {}) });
    };

    // Curated provider presets surface the current family first; runtime-advertised
    // models remain available underneath so custom/provider-discovered entries are preserved.
    for (const model of providerPreset?.models ?? []) add(model.id, model.label, model.description);
    for (const model of settings?.models ?? []) {
      if (model.providerID !== providerID) continue;
      add(model.modelID, model.name);
    }
    add(configuredModel, configuredModel);
    return output;
  }, [codex, configuredModel, providerID, providerPreset?.models, settings?.models]);

  const displayModel = useMemo(() => {
    if (providerID === 'codex' && configuredModel === 'codex-default' && codex.defaultModel) {
      return codex.models.find((item) => item.id === codex.defaultModel)?.label || codex.defaultModel;
    }
    return options.find((item) => item.id === configuredModel)?.label || configuredModel || 'Select model';
  }, [codex.defaultModel, codex.models, configuredModel, options, providerID]);

  const choose = async (modelID: string) => {
    const id = modelID.trim();
    if (!id || id === configuredModel) { setOpen(false); return; }
    setBusy(true);
    setError('');
    try {
      const current = settings ?? await window.cuppet.settings.get();
      const currentProvider = current.primary?.providerID || current.providerID || '';
      if (!currentProvider) throw new Error('Configure a provider before selecting a model.');
      const saved = await window.cuppet.settings.save({
        providerID: currentProvider,
        baseUrl: current.baseUrl || '',
        model: id,
        backgroundModel: current.secondary?.modelID || id,
        primaryEffort: '',
        secondaryEffort: current.secondary?.variant || '',
      });
      setSettings(saved);
      setCustomModel('');
      setOpen(false);
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (disabled || busy) return;
    const next = !open;
    setOpen(next);
    if (!next) return;
    setError('');
    try { await refresh(); }
    catch (value) { setError(message(value)); }
  };

  return (
    <div className={`model-picker${open ? ' open' : ''}`} ref={root}>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || busy}
        title={configuredModel ? `Model: ${displayModel}` : 'Select model'}
        onClick={() => void toggle()}
      >
        <span className="model-picker-name">{busy ? 'Switching…' : displayModel}</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox" aria-label="Models">
          <div className="model-picker-provider">{providerID === 'codex' ? providerLabel : `${providerLabel} · Latest models`}</div>
          {options.length > 0 ? options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === configuredModel}
              className={`model-picker-option${option.id === configuredModel ? ' selected' : ''}`}
              key={option.id}
              disabled={busy}
              onClick={() => void choose(option.id)}
            >
              <strong>{option.label}</strong>
              {option.id === configuredModel && <span className="model-picker-check" aria-hidden="true">✓</span>}
              {option.description && <small>{option.description}</small>}
            </button>
          )) : <div className="model-picker-empty">No advertised model list. Enter a model ID below.</div>}

          <div className="model-picker-custom">
            <input
              type="text"
              value={customModel}
              maxLength={240}
              spellCheck={false}
              autoComplete="off"
              placeholder="Model ID"
              aria-label="Custom model ID"
              onChange={(event) => setCustomModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                event.stopPropagation();
                if (customModel.trim() && !busy) void choose(customModel);
              }}
            />
            <button type="button" disabled={busy || !customModel.trim()} onClick={() => void choose(customModel)}>Use</button>
          </div>
          {error && <div className="model-picker-error" role="status">{error}</div>}
        </div>
      )}
    </div>
  );
}

function message(value: unknown) {
  return value instanceof Error ? value.message : String(value ?? 'Unable to load models.');
}
