import type { CapacityWeek } from '../../engine/capacityTypes'
import { fmtDateShort, fmtInt, fmtNum, fmtPct, fmtSigned } from '../format'

interface EditableCellProps {
  /** Current committed value, shown until the user edits */
  value: number
  digits: number
  /** True when this cell carries a user override */
  edited: boolean
  ariaLabel: string
  onCommit: (v: number) => void
}

/**
 * Numeric grid cell: uncontrolled input keyed on the committed value so a
 * recompute refreshes it; commits on blur, Enter blurs. Invalid or unchanged
 * input reverts silently.
 */
function EditableCell({ value, digits, edited, ariaLabel, onCommit }: EditableCellProps) {
  const shown = value.toFixed(digits)
  return (
    <input
      key={shown}
      type="text"
      inputMode="decimal"
      className={`cell-input${edited ? ' edited' : ''}`}
      defaultValue={shown}
      aria-label={ariaLabel}
      onBlur={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n) && n >= 0 && e.target.value.trim() !== '' && n !== value) {
          onCommit(n)
        } else {
          e.target.value = shown
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

interface CapacityGridProps {
  weeks: CapacityWeek[]
  /** Effective shrinkage fraction per week (override or default) */
  shrinkageOf: (week: string) => number
  volumeEdited: (week: string) => boolean
  ahtEdited: (week: string) => boolean
  shrinkageEdited: (week: string) => boolean
  slTarget: number
  onVolume: (week: string, v: number) => void
  onAht: (week: string, v: number) => void
  /** Receives a fraction 0..0.9 */
  onShrinkage: (week: string, v: number) => void
}

export function CapacityGrid({
  weeks,
  shrinkageOf,
  volumeEdited,
  ahtEdited,
  shrinkageEdited,
  slTarget,
  onVolume,
  onAht,
  onShrinkage,
}: CapacityGridProps) {
  const maxAbs = weeks.reduce((m, w) => Math.max(m, Math.abs(w.overUnder)), 0)
  const heatClass = (v: number) => (v < 0 ? 'heat-neg' : 'heat-pos')
  const heatStyle = (v: number) =>
    maxAbs > 0 ? { opacity: 0.45 + 0.55 * (Math.abs(v) / maxAbs) } : undefined

  return (
    <div className="scroll" style={{ maxHeight: 480 }}>
      <table className="table capacity-grid">
        <thead>
          <tr>
            <th>Week of</th>
            <th className="num">Volume</th>
            <th className="num">AHT s</th>
            <th className="num">Shrink %</th>
            <th className="num">Required FTE</th>
            <th className="num">Production HC</th>
            <th className="num">In training</th>
            <th className="num">Supply FTE</th>
            <th className="num">Over/(under)</th>
            <th className="num">Proj. SL</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.week}>
              <td>{fmtDateShort(w.week)}</td>
              <td className="num">
                <EditableCell
                  value={Math.round(w.volume)}
                  digits={0}
                  edited={volumeEdited(w.week)}
                  ariaLabel={`Volume week ${w.week}`}
                  onCommit={(v) => onVolume(w.week, v)}
                />
              </td>
              <td className="num">
                <EditableCell
                  value={Math.round(w.aht)}
                  digits={0}
                  edited={ahtEdited(w.week)}
                  ariaLabel={`AHT week ${w.week}`}
                  onCommit={(v) => onAht(w.week, v)}
                />
              </td>
              <td className="num">
                <EditableCell
                  value={shrinkageOf(w.week) * 100}
                  digits={0}
                  edited={shrinkageEdited(w.week)}
                  ariaLabel={`Shrinkage week ${w.week}`}
                  onCommit={(v) => onShrinkage(w.week, Math.min(90, Math.max(0, v)) / 100)}
                />
              </td>
              <td className="num">{fmtNum(w.requiredFte, 1)}</td>
              <td className="num">{fmtNum(w.productionHc, 1)}</td>
              <td className="num">{fmtInt(w.inTrainingHc)}</td>
              <td className="num">{fmtNum(w.supplyFte, 1)}</td>
              <td className={`num ${heatClass(w.overUnder)}`}>
                <span style={heatStyle(w.overUnder)}>{fmtSigned(w.overUnder, 1)}</span>
              </td>
              <td className="num" style={w.projectedSl < slTarget ? { color: 'var(--bad)' } : undefined}>
                {fmtPct(w.projectedSl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
