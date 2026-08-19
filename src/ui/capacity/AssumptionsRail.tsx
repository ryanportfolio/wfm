import { Slider } from '../controls/Slider'
import { fmtSignedPct } from '../format'
import type {
  CapacityRailState,
  CapacityStaffingState,
  ClassDefaults,
  ScenarioId,
  ScenarioOverrideState,
} from './state'

interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
}

/** Numeric input committing on blur/Enter, clamped to [min, max]. */
function NumberField({ label, value, min, max, step = 1, onCommit }: NumberFieldProps) {
  const commit = (raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    onCommit(Math.min(max, Math.max(min, n)))
  }
  return (
    <div className="field-row">
      <span>{label}</span>
      <input
        key={value}
        type="number"
        className="num-input"
        defaultValue={value}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

interface AssumptionsRailProps {
  rail: CapacityRailState
  classDefaults: ClassDefaults
  staffing: CapacityStaffingState
  scenario: ScenarioId
  overrides: Record<'upside' | 'downside', ScenarioOverrideState>
  suggesting: boolean
  hasPlan: boolean
  onRail: (patch: Partial<CapacityRailState>) => void
  onClassDefaults: (patch: Partial<ClassDefaults>) => void
  onStaffing: (patch: Partial<CapacityStaffingState>) => void
  onScenario: (s: ScenarioId) => void
  onOverride: (s: 'upside' | 'downside', patch: Partial<ScenarioOverrideState>) => void
  onSuggest: () => void
}

export function AssumptionsRail({
  rail,
  classDefaults,
  staffing,
  scenario,
  overrides,
  suggesting,
  hasPlan,
  onRail,
  onClassDefaults,
  onStaffing,
  onScenario,
  onOverride,
  onSuggest,
}: AssumptionsRailProps) {
  const erlangA = staffing.mode === 'erlangA'
  const scen = scenario === 'base' ? null : overrides[scenario]

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <h2>Scenario</h2>
        </div>
        <div className="seg" role="group" aria-label="Scenario">
          {(['base', 'upside', 'downside'] as ScenarioId[]).map((s) => (
            <button
              key={s}
              type="button"
              className={scenario === s ? 'active' : ''}
              onClick={() => onScenario(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {scen && scenario !== 'base' && (
          <div style={{ marginTop: 12 }}>
            <Slider
              label="Growth per week"
              value={scen.growthPct}
              min={-1}
              max={1}
              step={0.05}
              format={(v) => fmtSignedPct(v / 100, 2)}
              onChange={(v) => onOverride(scenario, { growthPct: v })}
            />
            <Slider
              label="Annual attrition"
              value={scen.attritionPct}
              min={10}
              max={60}
              format={(v) => `${v}%`}
              onChange={(v) => onOverride(scenario, { attritionPct: v })}
            />
            <Slider
              label="Shrinkage"
              value={scen.shrinkagePct}
              min={0}
              max={50}
              format={(v) => `${v}%`}
              onChange={(v) => onOverride(scenario, { shrinkagePct: v })}
            />
            <Slider
              label="AHT delta"
              value={scen.ahtDeltaPct}
              min={-20}
              max={20}
              format={(v) => fmtSignedPct(v / 100, 0)}
              onChange={(v) => onOverride(scenario, { ahtDeltaPct: v })}
            />
            <div className="slider-hint">
              Overrides apply on top of the base plan; base stays unchanged.
            </div>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={suggesting || !hasPlan}
            onClick={onSuggest}
          >
            {suggesting ? (
              <>
                <span className="spinner" /> Solving...
              </>
            ) : (
              'Suggest hiring'
            )}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Assumptions</h2>
        </div>
        <Slider
          label="Plan horizon"
          value={rail.weeks}
          min={13}
          max={78}
          format={(v) => `${v} wk`}
          onChange={(v) => onRail({ weeks: v })}
        />
        <NumberField
          label="Starting production HC (user-set)"
          value={rail.startingHc}
          min={1}
          max={5000}
          onCommit={(v) => onRail({ startingHc: v })}
        />
        <NumberField
          label="Paid hours per week"
          value={rail.paidHours}
          min={10}
          max={60}
          onCommit={(v) => onRail({ paidHours: v })}
        />
        <Slider
          label="Volume growth per week"
          value={rail.growthPct}
          min={-1}
          max={1}
          step={0.05}
          format={(v) => fmtSignedPct(v / 100, 2)}
          onChange={(v) => onRail({ growthPct: v })}
        />
        <Slider
          label="Annual attrition"
          value={rail.attritionPct}
          min={10}
          max={60}
          format={(v) => `${v}%`}
          onChange={(v) => onRail({ attritionPct: v })}
        />
        <Slider
          label="Default shrinkage"
          value={rail.shrinkagePct}
          min={0}
          max={50}
          format={(v) => `${v}%`}
          onChange={(v) => onRail({ shrinkagePct: v })}
        />
        <Slider
          label="Ramp weeks"
          value={rail.rampWeeks}
          min={2}
          max={16}
          format={(v) => `${v} wk`}
          onChange={(v) => onRail({ rampWeeks: v })}
        />
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Class defaults</h2>
          <span className="card-subtitle">New and suggested hire classes</span>
        </div>
        <NumberField
          label="Training weeks"
          value={classDefaults.trainingWeeks}
          min={1}
          max={20}
          onCommit={(v) => onClassDefaults({ trainingWeeks: Math.round(v) })}
        />
        <NumberField
          label="Nesting weeks"
          value={classDefaults.nestingWeeks}
          min={0}
          max={12}
          onCommit={(v) => onClassDefaults({ nestingWeeks: Math.round(v) })}
        />
        <NumberField
          label="Nesting productivity %"
          value={classDefaults.nestingProductivityPct}
          min={0}
          max={100}
          onCommit={(v) => onClassDefaults({ nestingProductivityPct: Math.round(v) })}
        />
        <NumberField
          label="Min class size"
          value={classDefaults.minClassSize}
          min={1}
          max={100}
          onCommit={(v) => onClassDefaults({ minClassSize: Math.round(v) })}
        />
        <NumberField
          label="Max class size"
          value={classDefaults.maxClassSize}
          min={1}
          max={200}
          onCommit={(v) => onClassDefaults({ maxClassSize: Math.round(v) })}
        />
        <NumberField
          label="Max classes per quarter"
          value={classDefaults.maxClassesPerQuarter}
          min={1}
          max={8}
          onCommit={(v) => onClassDefaults({ maxClassesPerQuarter: Math.round(v) })}
        />
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Staffing model</h2>
          <span className="card-subtitle">Drives interval-true required FTE</span>
        </div>
        <div className="slider-row">
          <div className="slider-head">
            <span>Erlang mode</span>
          </div>
          <div className="seg">
            <button
              type="button"
              className={erlangA ? 'active' : ''}
              onClick={() => onStaffing({ mode: 'erlangA' })}
            >
              Erlang A
            </button>
            <button
              type="button"
              className={!erlangA ? 'active' : ''}
              onClick={() => onStaffing({ mode: 'erlangC' })}
            >
              Erlang C
            </button>
          </div>
        </div>
        <Slider
          label="Service level target"
          value={staffing.slPct}
          min={50}
          max={95}
          format={(v) => `${v}%`}
          onChange={(v) => onStaffing({ slPct: v })}
        />
        <Slider
          label="Answered within"
          value={staffing.slSeconds}
          min={10}
          max={60}
          step={5}
          format={(v) => `${v} s`}
          onChange={(v) => onStaffing({ slSeconds: v })}
        />
        <Slider
          label="Mean patience"
          value={staffing.patienceSec}
          min={30}
          max={300}
          step={10}
          disabled={!erlangA}
          format={(v) => `${v} s`}
          hint={erlangA ? undefined : 'Erlang A only'}
          onChange={(v) => onStaffing({ patienceSec: v })}
        />
        <Slider
          label="Occupancy cap"
          value={staffing.occupancyCapPct}
          min={75}
          max={95}
          format={(v) => `${v}%`}
          onChange={(v) => onStaffing({ occupancyCapPct: v })}
        />
      </div>
    </div>
  )
}
