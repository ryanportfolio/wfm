import type { HireClass } from '../../engine/capacityTypes'
import { addDays } from '../../engine/series'
import { fmtDateShort, fmtPct } from '../format'

interface HireClassesCardProps {
  hireClasses: HireClass[]
  suggestions: HireClass[] | null
  planMondays: string[]
  onAdd: () => void
  onRemove: (id: string) => void
  onPatch: (id: string, patch: Partial<HireClass>) => void
  onAcceptAll: () => void
  onDismissSuggestions: () => void
}

interface ClassNumberProps {
  value: number
  min: number
  max: number
  ariaLabel: string
  onCommit: (v: number) => void
}

function ClassNumber({ value, min, max, ariaLabel, onCommit }: ClassNumberProps) {
  return (
    <input
      key={value}
      type="number"
      className="num-input num-input-sm"
      defaultValue={value}
      min={min}
      max={max}
      aria-label={ariaLabel}
      onBlur={(e) => {
        const n = Math.round(Number(e.target.value))
        if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)))
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function HireClassesCard({
  hireClasses,
  suggestions,
  planMondays,
  onAdd,
  onRemove,
  onPatch,
  onAcceptAll,
  onDismissSuggestions,
}: HireClassesCardProps) {
  const gradWeek = (hc: HireClass) => addDays(hc.startWeek, 7 * (hc.trainingWeeks + hc.nestingWeeks))
  return (
    <div className="card">
      <div className="card-title">
        <h2>Hire classes</h2>
        <span className="card-subtitle">
          Trainees count as headcount, contribute during nesting, graduate at full weight
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onAdd}>
          Add class
        </button>
      </div>

      {hireClasses.length === 0 && (!suggestions || suggestions.length === 0) && (
        <div className="note">
          No hire classes in the plan. Add one, or click Suggest hiring to let the solver place
          classes against the shortfall weeks.
        </div>
      )}

      {hireClasses.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Start week</th>
                <th className="num">Size</th>
                <th className="num">Training wk</th>
                <th className="num">Nesting wk</th>
                <th className="num">Nesting prod.</th>
                <th>Graduates</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hireClasses.map((hc) => (
                <tr key={hc.id}>
                  <td>
                    <select
                      value={hc.startWeek}
                      aria-label={`Start week for class ${hc.id}`}
                      onChange={(e) => onPatch(hc.id, { startWeek: e.target.value })}
                    >
                      {planMondays.map((m) => (
                        <option key={m} value={m}>
                          {fmtDateShort(m)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <ClassNumber
                      value={hc.size}
                      min={1}
                      max={200}
                      ariaLabel={`Size for class ${hc.id}`}
                      onCommit={(v) => onPatch(hc.id, { size: v })}
                    />
                  </td>
                  <td className="num">
                    <ClassNumber
                      value={hc.trainingWeeks}
                      min={1}
                      max={20}
                      ariaLabel={`Training weeks for class ${hc.id}`}
                      onCommit={(v) => onPatch(hc.id, { trainingWeeks: v })}
                    />
                  </td>
                  <td className="num">
                    <ClassNumber
                      value={hc.nestingWeeks}
                      min={0}
                      max={12}
                      ariaLabel={`Nesting weeks for class ${hc.id}`}
                      onCommit={(v) => onPatch(hc.id, { nestingWeeks: v })}
                    />
                  </td>
                  <td className="num">
                    <ClassNumber
                      value={Math.round(hc.nestingProductivity * 100)}
                      min={0}
                      max={100}
                      ariaLabel={`Nesting productivity for class ${hc.id}`}
                      onCommit={(v) => onPatch(hc.id, { nestingProductivity: v / 100 })}
                    />
                  </td>
                  <td>{fmtDateShort(gradWeek(hc))}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => onRemove(hc.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suggestions && (
        <div className="suggestion-block">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="badge badge-suggested">Solver suggestions</span>
            {suggestions.length > 0 ? (
              <>
                <span className="note">
                  {suggestions.length} class{suggestions.length === 1 ? '' : 'es'},{' '}
                  {suggestions.reduce((a, s) => a + s.size, 0)} hires. Greedy: earliest shortfall
                  first, smallest covering class, quarter cap respected.
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-primary" onClick={onAcceptAll}>
                  Accept all
                </button>
                <button type="button" className="btn" onClick={onDismissSuggestions}>
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <span className="note">No shortfall weeks at current assumptions; nothing to suggest.</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" onClick={onDismissSuggestions}>
                  Dismiss
                </button>
              </>
            )}
          </div>
          {suggestions.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Start week</th>
                  <th className="num">Size</th>
                  <th className="num">Training wk</th>
                  <th className="num">Nesting wk</th>
                  <th className="num">Nesting prod.</th>
                  <th>Graduates</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.id} className="suggested-row">
                    <td>{fmtDateShort(s.startWeek)}</td>
                    <td className="num">{s.size}</td>
                    <td className="num">{s.trainingWeeks}</td>
                    <td className="num">{s.nestingWeeks}</td>
                    <td className="num">{fmtPct(s.nestingProductivity, 0)}</td>
                    <td>{fmtDateShort(gradWeek(s))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
