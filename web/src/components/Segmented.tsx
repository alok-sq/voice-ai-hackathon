import type { ReactNode } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props<T extends string> {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Single-choice toggle. A radio group for assistive tech, a segmented control visually. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: Props<T>) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`seg__btn${o.value === value ? " is-active" : ""}`}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
