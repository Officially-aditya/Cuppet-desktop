import { useEffect, useId, useRef, useState } from 'react';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
};

export function SelectControl({ value, options, onChange, ariaLabel, disabled = false, autoFocus = false }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (autoFocus) trigger.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const index = options.findIndex((option) => option.value === value);
    if (index >= 0) setActiveIndex(index);
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const move = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div className={`cuppet-select${open ? ' open' : ''}`} ref={root} onClick={(event) => event.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className="cuppet-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(-1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!open) setOpen(true);
            else if (options[activeIndex]) choose(options[activeIndex]);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span>{selected?.label ?? 'Choose'}</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div id={`${id}-listbox`} className="cuppet-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`cuppet-select-option${option.value === value ? ' selected' : ''}${index === activeIndex ? ' active' : ''}`}
              key={option.value}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <span className="cuppet-select-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
