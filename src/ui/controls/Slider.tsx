import { useId } from 'react'
import { Term } from '../Term'
import type { TermKey } from '../glossary'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  hint?: string
  /** Glossary key; when set, the visible label opens the definition. */
  term?: TermKey
  format?: (v: number) => string
  onChange: (v: number) => void
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  hint,
  term,
  format,
  onChange,
}: SliderProps) {
  const id = useId()
  return (
    <div className={`slider-row${disabled ? ' disabled' : ''}`}>
      <div className="slider-head">
        {term ? (
          <Term term={term}>{label}</Term>
        ) : (
          <label htmlFor={id}>{label}</label>
        )}
        <span className="slider-value">{format ? format(value) : String(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <div className="slider-hint">{hint}</div> : null}
    </div>
  )
}
