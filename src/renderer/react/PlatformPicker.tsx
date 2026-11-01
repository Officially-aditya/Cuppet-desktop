import { useRef, useState } from 'react';
import { SelectControl } from './SelectControl';
import { PlatformLogo } from './PlatformLogo';
import { hydrateClientProviderSettings, useClientProviderSettings } from './client-provider-state';
import { notifyProviderSettingsChanged } from './provider-settings-events';

type Props = {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

export function PlatformPicker({ disabled = false, onBusyChange }: Props) {
  const settings = useClientProviderSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const providerID = settings?.primary?.providerID || settings?.providerID || '';
  const options = [...new Set(settings?.savedProviderIDs ?? [])].filter(Boolean).map((id) => ({
    value: id,
    label: settings?.presets?.find((preset) => preset.id === id)?.label || id,
    icon: <PlatformLogo providerID={id} />,
    disabled: disabled || busy,
  }));

  const choose = async (id: string) => {
    if (disabled || saving.current || id === providerID || !options.some((option) => option.value === id)) return;
    saving.current = true;
    setBusy(true);
    setError('');
    onBusyChange?.(true);
    try {
      // The host restores this platform's saved models, efforts, and endpoint.
      const next = await window.cuppet.settings.save({ providerID: id });
      hydrateClientProviderSettings(next);
      notifyProviderSettingsChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      saving.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <div className="platform-picker" aria-busy={busy} onClickCapture={() => setError('')} onKeyDownCapture={() => setError('')} title={!options.length ? 'Add a platform in Settings' : undefined}>
      <SelectControl
        value={providerID}
        options={options.length ? options : [{ value: '', label: 'Platform', icon: <PlatformLogo providerID="" />, disabled: true }]}
        iconOnly
        onChange={choose}
        ariaLabel="Select platform"
        disabled={disabled || busy || !options.length}
      />
      {error && <div className="platform-picker-error" role="alert">{error}</div>}
    </div>
  );
}
