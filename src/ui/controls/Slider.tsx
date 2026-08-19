interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  hint?: string
  format?: (v: number) => string
  onChange: (v: number) => void
}

export function Slider({ label, value, min, max, step = 1, disabled, hint, format, onChange }: SliderProps) {
  return (
    <div className={`slider-row${disabled ? ' disabled' : ''}`}>
      <div className="slider-head">
        <span>{label}</span>
        <span className="slider-value">{format ? format(value) : String(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <div className="slider-hint">{hint}</div> : null}
    </div>
  )
}
