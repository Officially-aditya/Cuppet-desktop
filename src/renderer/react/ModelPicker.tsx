import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodexModelCatalog, ProviderSettings } from '../types';

type ModelOption = {
  id: string;
  label: string;
  description?: string;
};

type PickerStage = 'models' | 'efforts';

type Props = {
  disabled?: boolean;
};

const EMPTY_CODEX: CodexModelCatalog = { available: false, models: [], defaultModel: null };

export function ModelPicker({ disabled = false }: Props) {
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PickerStage>('models');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [codex, setCodex] = useState<CodexModelCatalog>(EMPTY_CODEX);
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
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
        setStage('models');
      }
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

    for (const model of providerPreset?.models ?? []) add(model.id, model.label, model.description);
    for (const model of settings?.models ?? []) {
      if (model.providerID !== providerID) continue;
      add(model.modelID, model.name);
    }
    add(configuredModel, configuredModel);
    return output;
  }, [codex, configuredModel, providerID, providerPreset?.models, settings?.models]);

  const effortState = modelEffortState(providerID, configuredModel, settings, codex);
  const effortOptions = effortState.options;
  const explicitEffort = providerID === 'codex'
    ? String(settings?.primaryEffort ?? '').trim()
    : String(settings?.primary?.variant ?? '').trim();

  const displayModel = useMemo(() => {
    if (providerID === 'codex' && configuredModel === 'codex-default' && codex.defaultModel) {
      return codex.models.find((item) => item.id === codex.defaultModel)?.label || codex.defaultModel;
    }
    return options.find((item) => item.id === configuredModel)?.label || configuredModel || 'Select model';
  }, [codex.defaultModel, codex.models, configuredModel, options, providerID]);

  const chooseModel = async (modelID: string) => {
    const id = modelID.trim();
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const current = settings ?? await window.cuppet.settings.get();
      const currentProvider = current.primary?.providerID || current.providerID || '';
      if (!currentProvider) throw new Error('Configure a provider before selecting a model.');

      const nextEffortState = modelEffortState(currentProvider, id, current, codex);
      if (id !== configuredModel) {
        const nextEffort = effortForModel(currentProvider, id, current, codex);
        const next = await window.cuppet.settings.save({
          providerID: currentProvider,
          baseUrl: current.baseUrl || '',
          model: id,
          backgroundModel: current.secondary?.modelID || id,
          primaryEffort: nextEffort,
          secondaryEffort: current.secondary?.variant || '',
        });
        setSettings(next);
      }

      if (nextEffortState.options.length > 0) {
        setStage('efforts');
        setOpen(true);
      } else {
        setOpen(false);
        setStage('models');
      }
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  };

  const chooseEffort = async (effort: string) => {
    const value = effort === 'default' ? '' : effort.trim();
    if (!configuredModel || (value && !effortOptions.includes(value))) return;
    if (value === explicitEffort || (!value && !explicitEffort)) {
      setOpen(false);
      setStage('models');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const current = settings ?? await window.cuppet.settings.get();
      const currentProvider = current.primary?.providerID || current.providerID || '';
      if (!currentProvider) throw new Error('Configure a provider before selecting reasoning effort.');
      const saved = await window.cuppet.settings.save({
        providerID: currentProvider,
        baseUrl: current.baseUrl || '',
        model: current.primary?.modelID || configuredModel,
        backgroundModel: current.secondary?.modelID || current.primary?.modelID || configuredModel,
        primaryEffort: value,
        secondaryEffort: current.secondary?.variant || '',
      });
      setSettings(saved);
      setOpen(false);
      setStage('models');
    } catch (value) {
      setError(message(value));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (disabled || busy) return;
    if (open) {
      setOpen(false);
      setStage('models');
      return;
    }
    setStage('models');
    setOpen(true);
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
        <span className="model-picker-name">{displayModel}</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox" aria-label={stage === 'models' ? 'Models' : 'Reasoning effort'}>
          {stage === 'models' ? (
            <>
              <div className="model-picker-provider">{providerID === 'codex' ? providerLabel : `${providerLabel} · Latest models`}</div>
              {options.length > 0 ? options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === configuredModel}
                  className={`model-picker-option${option.id === configuredModel ? ' selected' : ''}`}
                  key={option.id}
                  disabled={busy}
                  onClick={() => void chooseModel(option.id)}
                >
                  <strong>{option.label}</strong>
                  {option.id === configuredModel && <span className="model-picker-check" aria-hidden="true">✓</span>}
                  {option.description && <small>{option.description}</small>}
                </button>
              )) : <div className="model-picker-empty">No models advertised by this provider.</div>}
            </>
          ) : (
            <>
              <button type="button" className="model-picker-back" onClick={() => setStage('models')}>← Models</button>
              <div className="model-picker-provider">{displayModel} · Effort</div>
              <button
                type="button"
                role="option"
                aria-selected={!explicitEffort}
                className={`model-picker-effort-option${!explicitEffort ? ' selected' : ''}`}
                onClick={() => void chooseEffort('default')}
              >
                <span>Default{effortState.defaultEffort ? ` · ${formatEffort(effortState.defaultEffort)}` : ''}</span>
                {!explicitEffort && <span aria-hidden="true">✓</span>}
              </button>
              {effortOptions.map((effort) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={explicitEffort === effort}
                  className={`model-picker-effort-option${explicitEffort === effort ? ' selected' : ''}`}
                  key={effort}
                  onClick={() => void chooseEffort(effort)}
                >
                  <span>{formatEffort(effort)}</span>
                  {explicitEffort === effort && <span aria-hidden="true">✓</span>}
                </button>
              ))}
            </>
          )}
          {error && <div className="model-picker-error" role="status">{error}</div>}
        </div>
      )}
    </div>
  );
}

function modelEffortState(providerID: string, modelID: string, settings: ProviderSettings | null, codex: CodexModelCatalog) {
  if (providerID === 'codex') {
    const effectiveID = modelID === 'codex-default' ? codex.defaultModel || '' : modelID;
    const model = codex.models.find((item) => item.id === effectiveID);
    return {
      options: model?.efforts ?? [],
      defaultEffort: String(model?.defaultEffort ?? '').trim(),
    };
  }
  const model = settings?.models?.find((item) => item.providerID === providerID && item.modelID === modelID);
  return {
    options: model?.variants ?? [],
    defaultEffort: '',
  };
}

function effortForModel(providerID: string, modelID: string, settings: ProviderSettings, codex: CodexModelCatalog) {
  const currentEffort = providerID === 'codex'
    ? String(settings.primaryEffort ?? '').trim()
    : String(settings.primary?.variant ?? '').trim();
  const state = modelEffortState(providerID, modelID, settings, codex);
  if (currentEffort && state.options.includes(currentEffort)) return currentEffort;
  return '';
}

function formatEffort(value: string) {
  const effort = value.trim();
  if (!effort) return 'Default';
  return effort.split(/[-_]/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function message(value: unknown) {
  return value instanceof Error ? value.message : String(value ?? 'Unable to load models.');
}
