import { useEffect, useId, useRef, useState } from 'react';
import type { ComposerMode } from './ChatPane';

type ModeOption = {
  value: ComposerMode;
  label: string;
  description: string;
};

const MODE_OPTIONS: ModeOption[] = [
  { value: 'build', label: 'Build', description: 'Write code and edit files directly' },
  { value: 'plan', label: 'Plan', description: 'Formulate architecture and plan before changing code' },
  { value: 'orchestrate', label: 'Orchestrate', description: 'Decompose complex tasks into subagents' },
];

type Props = {
  value: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  disabled?: boolean;
};

export function ModePicker({ value, onChange, disabled = false }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, MODE_OPTIONS.findIndex((item) => item.value === value)));

  const selected = MODE_OPTIONS.find((item) => item.value === value) ?? MODE_OPTIONS[0];

  useEffect(() => {
    const index = MODE_OPTIONS.findIndex((item) => item.value === value);
    if (index >= 0) setActiveIndex(index);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const move = (direction: 1 | -1) => {
    setActiveIndex((current) => (current + direction + MODE_OPTIONS.length) % MODE_OPTIONS.length);
  };

  const choose = (mode: ComposerMode) => {
    onChange(mode);
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <div className={`composer-mode-picker${open ? ' open' : ''}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-mode-trigger"
        aria-label="Mode"
        title={`Mode: ${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-modelist`}
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
            else if (MODE_OPTIONS[activeIndex]) choose(MODE_OPTIONS[activeIndex].value);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span className="composer-mode-label">{selected.label}</span>
        <svg className="composer-mode-chevron" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="m2.25 3.5 2.75 2.75L7.75 3.5" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div id={`${id}-modelist`} className="composer-mode-menu" role="listbox" aria-label="Composer mode">
          <div className="composer-mode-menu-header">Composer mode</div>
          {MODE_OPTIONS.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <button
                type="button"
                role="option"
                key={option.value}
                aria-selected={isSelected}
                className={`composer-mode-option${isSelected ? ' selected' : ''}${index === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.value)}
              >
                <div className="composer-mode-option-text">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </div>
                {isSelected && (
                  <svg className="composer-mode-check" viewBox="0 0 16 16" fill="none" width="12" height="12" aria-hidden="true">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
