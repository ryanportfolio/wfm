import { useEffect, useMemo, useRef, useState } from 'react'
import type { IntervalRecord } from '../engine/types'
import type { CapacityAssumptions, CapacityPlan, HireClass } from '../engine/capacityTypes'
import { buildCapacityPlan } from '../engine/capacity'
import { applyCapacityScenario, suggestHiring } from '../engine/capacitySupply'
import type { ChartTheme } from './theme'
import { fmtDateShort, fmtInt, fmtNum, fmtPct, fmtSigned } from './format'
import { AssumptionsRail } from './capacity/AssumptionsRail'
import { CapacityChart } from './capacity/CapacityChart'
import { CapacityGrid } from './capacity/CapacityGrid'
import { HireClassesCard } from './capacity/HireClassesCard'
import { SensitivityCard } from './capacity/SensitivityCard'
import type { SensitivityRow } from './capacity/SensitivityCard'
import {
  DEFAULT_CAPACITY_STAFFING,
  DEFAULT_CLASS_DEFAULTS,
  DEFAULT_RAIL,
  DEFAULT_SCENARIO_OVERRIDES,
  assumptionsKey,
  buildAssumptions,
  toConstraints,
} from './capacity/state'
import type {
  CapacityRailState,
  CapacityStaffingState,
  ClassDefaults,
  ScenarioId,
  ScenarioOverrideState,
} from './capacity/state'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/**
 * Debounced (200 ms), cached capacity plan. The cache key serializes the full
 * assumptions object, so slider scrubbing recomputes once and tab switches or
 * scenario flips back are instant.
 */
function useCapacityPlan(
  records: IntervalRecord[],
  assumptions: CapacityAssumptions | null,
): { plan: CapacityPlan | null; computing: boolean } {
  const debounced = useDebounced(assumptions, 200)
  const cache = useRef(new Map<string, CapacityPlan>())
  const [plan, setPlan] = useState<CapacityPlan | null>(null)
  const [computing, setComputing] = useState(false)

  useEffect(() => {
    cache.current.clear()
    setPlan(null)
  }, [records])

  useEffect(() => {
    if (!debounced) {
      setPlan(null)
      setComputing(false)
      return
    }
    const key = assumptionsKey(debounced)
    const hit = cache.current.get(key)
    if (hit) {
      setPlan(hit)
      setComputing(false)
      return
    }
    setComputing(true)
    // Yield a frame so the spinner paints before the Erlang math blocks.
    const id = setTimeout(() => {
      const p = buildCapacityPlan(records, debounced)
      cache.current.set(key, p)
      setPlan(p)
      setComputing(false)
    }, 30)
    return () => clearTimeout(id)
  }, [debounced, records])

  return { plan, computing }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function cloneAssumptions(a: CapacityAssumptions): CapacityAssumptions {
  return {
    ...a,
    volumeOverrides: new Map(a.volumeOverrides),
    ahtOverrides: new Map(a.ahtOverrides),
    shrinkageByWeek: new Map(a.shrinkageByWeek),
    hireClasses: a.hireClasses.map((h) => ({ ...h })),
    staffing: { ...a.staffing },
  }
}

interface CapacityTabProps {
  records: IntervalRecord[]
  queue: string
  theme: ChartTheme
}

export function CapacityTab({ records, queue, theme }: CapacityTabProps) {
  const isChat = queue.toLowerCase().includes('chat')

  const [rail, setRail] = useState<CapacityRailState>(DEFAULT_RAIL)
  const [classDefaults, setClassDefaults] = useState<ClassDefaults>(DEFAULT_CLASS_DEFAULTS)
  const [staffing, setStaffing] = useState<CapacityStaffingState>(DEFAULT_CAPACITY_STAFFING)
  const [scenario, setScenario] = useState<ScenarioId>('base')
  const [overrides, setOverrides] = useState(DEFAULT_SCENARIO_OVERRIDES)
  const [volumeOverrides, setVolumeOverrides] = useState<Map<string, number>>(new Map())
  const [ahtOverrides, setAhtOverrides] = useState<Map<string, number>>(new Map())
  const [shrinkageByWeek, setShrinkageByWeek] = useState<Map<string, number>>(new Map())
  const [hireClasses, setHireClasses] = useState<HireClass[]>([])
  const nextId = useRef(1)

  // Per-week edits and classes reset with a new dataset or queue.
  useEffect(() => {
    setVolumeOverrides(new Map())
    setAhtOverrides(new Map())
    setShrinkageByWeek(new Map())
    setHireClasses([])
  }, [records, queue])

  const baseAssumptions = useMemo(
    () =>
      buildAssumptions(
        queue,
        rail,
        staffing,
        isChat,
        volumeOverrides,
        ahtOverrides,
        shrinkageByWeek,
        hireClasses,
      ),
    [queue, rail, staffing, isChat, volumeOverrides, ahtOverrides, shrinkageByWeek, hireClasses],
  )

  const { plan: basePlan, computing: baseComputing } = useCapacityPlan(records, baseAssumptions)

  const scenarioAssumptions = useMemo(() => {
    if (scenario === 'base') return null
    const o: ScenarioOverrideState = overrides[scenario]
    const { assumptions, ahtDeltaPct } = applyCapacityScenario(baseAssumptions, {
      growthWeeklyPct: o.growthPct / 100,
      attritionAnnualPct: o.attritionPct / 100,
      defaultShrinkage: o.shrinkagePct / 100,
      ahtDeltaPct: o.ahtDeltaPct / 100,
    })
    // AHT lives on the demand side: apply the delta as per-week overrides on
    // top of the base plan's weekly AHT (which already includes user edits).
    if (ahtDeltaPct !== 0 && basePlan) {
      assumptions.ahtOverrides = new Map(
        basePlan.weeks.map((w) => [w.week, w.aht * (1 + ahtDeltaPct)]),
      )
    }
    return assumptions
  }, [scenario, overrides, baseAssumptions, basePlan])

  const { plan: scenarioPlan, computing: scenarioComputing } = useCapacityPlan(
    records,
    scenarioAssumptions,
  )

  const plan = scenario === 'base' ? basePlan : scenarioPlan
  const effective = scenario === 'base' ? baseAssumptions : scenarioAssumptions
  const computing = baseComputing || scenarioComputing

  // Solver suggestions and sensitivity are point-in-time results: any plan
  // change invalidates them.
  const [suggestions, setSuggestions] = useState<HireClass[] | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [sensRows, setSensRows] = useState<SensitivityRow[] | null>(null)
  const [sensRunning, setSensRunning] = useState(false)
  const [sensProgress, setSensProgress] = useState('')
  useEffect(() => {
    setSuggestions(null)
    setSensRows(null)
  }, [plan])

  const suggest = () => {
    if (!plan || !effective) return
    setSuggesting(true)
    setTimeout(() => {
      const shortfalls = plan.weeks
        .filter((w) => w.overUnder < 0)
        .map((w) => ({ week: w.week, gap: -w.overUnder }))
      const mondays = plan.weeks.map((w) => w.week)
      const result =
        shortfalls.length > 0
          ? suggestHiring(shortfalls, effective, toConstraints(classDefaults), mondays)
          : []
      setSuggestions(result)
      setSuggesting(false)
    }, 30)
  }

  const acceptAll = () => {
    if (!suggestions || suggestions.length === 0) return
    setHireClasses((prev) => [
      ...prev,
      ...suggestions.map((s) => ({ ...s, id: `class-${nextId.current++}` })),
    ])
    setSuggestions(null)
  }

  const addClass = () => {
    const start = plan?.weeks[0]?.week
    if (!start) return
    setHireClasses((prev) => [
      ...prev,
      {
        id: `class-${nextId.current++}`,
        startWeek: start,
        size: clamp(15, classDefaults.minClassSize, classDefaults.maxClassSize),
        trainingWeeks: classDefaults.trainingWeeks,
        nestingWeeks: classDefaults.nestingWeeks,
        nestingProductivity: classDefaults.nestingProductivityPct / 100,
      },
    ])
  }

  const patchClass = (id: string, patch: Partial<HireClass>) =>
    setHireClasses((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)))
  const removeClass = (id: string) => setHireClasses((prev) => prev.filter((h) => h.id !== id))

  const shrinkageOf = (week: string): number =>
    effective
      ? effective.shrinkageByWeek.get(week) ?? effective.defaultShrinkage
      : rail.shrinkagePct / 100

  const computeSensitivity = () => {
    if (!plan || !effective) return
    const cur = plan
    const a = effective
    const avgRequired = cur.weeks.reduce((s, w) => s + w.requiredFte, 0) / cur.weeks.length
    const volMap = (f: number) => new Map(cur.weeks.map((w) => [w.week, w.volume * f]))
    const ahtMap = (f: number) => new Map(cur.weeks.map((w) => [w.week, w.aht * f]))
    const shiftShrink = (c: CapacityAssumptions, pp: number) => {
      c.defaultShrinkage = clamp(a.defaultShrinkage + pp, 0, 0.9)
      c.shrinkageByWeek = new Map(
        [...a.shrinkageByWeek].map(([k, v]) => [k, clamp(v + pp, 0, 0.9)]),
      )
    }
    const levers: { lever: string; modify: (c: CapacityAssumptions) => void }[] = [
      { lever: 'Volume +10%', modify: (c) => (c.volumeOverrides = volMap(1.1)) },
      { lever: 'Volume -10%', modify: (c) => (c.volumeOverrides = volMap(0.9)) },
      { lever: 'AHT +5%', modify: (c) => (c.ahtOverrides = ahtMap(1.05)) },
      { lever: 'AHT -5%', modify: (c) => (c.ahtOverrides = ahtMap(0.95)) },
      {
        lever: 'Attrition +10 pts',
        modify: (c) => (c.attritionAnnualPct = clamp(a.attritionAnnualPct + 0.1, 0.01, 0.95)),
      },
      {
        lever: 'Attrition -10 pts',
        modify: (c) => (c.attritionAnnualPct = clamp(a.attritionAnnualPct - 0.1, 0.01, 0.95)),
      },
      { lever: 'Shrinkage +5 pts', modify: (c) => shiftShrink(c, 0.05) },
      { lever: 'Shrinkage -5 pts', modify: (c) => shiftShrink(c, -0.05) },
    ]

    setSensRunning(true)
    setSensRows(null)
    const results: SensitivityRow[] = []
    let i = 0
    const step = () => {
      if (i >= levers.length) {
        setSensRows(results)
        setSensRunning(false)
        return
      }
      setSensProgress(`${i + 1}/${levers.length}`)
      // Yield between runs so the progress label paints.
      setTimeout(() => {
        const copy = cloneAssumptions(a)
        levers[i].modify(copy)
        const p = buildCapacityPlan(records, copy)
        const avg = p.weeks.reduce((s, w) => s + w.requiredFte, 0) / p.weeks.length
        const worst = Math.min(...p.weeks.map((w) => w.overUnder))
        results.push({
          lever: levers[i].lever,
          deltaAvgRequired: avg - avgRequired,
          worstOverUnder: worst,
        })
        i++
        step()
      }, 30)
    }
    step()
  }

  const exportCsv = () => {
    if (!plan) return
    const header =
      'week,volume,aht_sec,shrinkage_pct,required_fte,production_hc,in_training_hc,supply_fte,over_under,projected_sl_pct'
    const lines = plan.weeks.map((w) =>
      [
        w.week,
        Math.round(w.volume),
        Math.round(w.aht),
        (shrinkageOf(w.week) * 100).toFixed(1),
        w.requiredFte.toFixed(1),
        w.productionHc.toFixed(1),
        w.inTrainingHc.toFixed(1),
        w.supplyFte.toFixed(1),
        w.overUnder.toFixed(1),
        (w.projectedSl * 100).toFixed(1),
      ].join(','),
    )
    const blob = new Blob([[header, ...lines].join('\n') + '\n'], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `capacity-plan-${queue}-${scenario}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const worstWeek = useMemo(() => {
    if (!plan || plan.weeks.length === 0) return null
    return plan.weeks.reduce((m, w) => (w.overUnder < m.overUnder ? w : m), plan.weeks[0])
  }, [plan])
  const worstSlWeek = useMemo(() => {
    if (!plan || plan.weeks.length === 0) return null
    return plan.weeks.reduce((m, w) => (w.projectedSl < m.projectedSl ? w : m), plan.weeks[0])
  }, [plan])
  const plannedHires = hireClasses.reduce((s, h) => s + h.size, 0)
  const suggestedHires = suggestions?.reduce((s, h) => s + h.size, 0) ?? 0

  const baseWorst = useMemo(() => {
    if (!basePlan || basePlan.weeks.length === 0) return null
    return Math.min(...basePlan.weeks.map((w) => w.overUnder))
  }, [basePlan])

  const planMondays = useMemo(() => (plan ? plan.weeks.map((w) => w.week) : []), [plan])

  return (
    <div className="staffing-layout">
      <AssumptionsRail
        rail={rail}
        classDefaults={classDefaults}
        staffing={staffing}
        scenario={scenario}
        overrides={overrides}
        suggesting={suggesting}
        hasPlan={plan !== null}
        onRail={(patch) => setRail((s) => ({ ...s, ...patch }))}
        onClassDefaults={(patch) => setClassDefaults((s) => ({ ...s, ...patch }))}
        onStaffing={(patch) => setStaffing((s) => ({ ...s, ...patch }))}
        onScenario={setScenario}
        onOverride={(s, patch) =>
          setOverrides((prev) => ({ ...prev, [s]: { ...prev[s], ...patch } }))
        }
        onSuggest={suggest}
      />

      <div className="stack">
        <div className="row">
          <h2>
            {rail.weeks}-week capacity plan: {queue}
            {scenario !== 'base' ? ` (${scenario})` : ''}
          </h2>
          {computing && (
            <span className="note">
              <span className="spinner" /> Recomputing plan...
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={!plan} onClick={exportCsv}>
            Export plan CSV
          </button>
        </div>

        {!plan && (
          <div className="card">
            <div className="note">
              <span className="spinner" /> Building the capacity plan: interval-true Erlang
              staffing for every plan week takes about a second on first run.
            </div>
          </div>
        )}

        {plan && worstWeek && worstSlWeek && (
          <div className="cards-row">
            <div className="card">
              <div className="metric-label">Peak under-coverage</div>
              <div className="metric-value" style={worstWeek.overUnder < 0 ? { color: 'var(--bad)' } : undefined}>
                {worstWeek.overUnder < 0 ? fmtNum(worstWeek.overUnder, 1) : 'covered'}
              </div>
              <div className="metric-sub">
                {worstWeek.overUnder < 0
                  ? `FTE short, week of ${fmtDateShort(worstWeek.week)}`
                  : `every week at or above requirement; slack ${fmtSigned(worstWeek.overUnder, 1)}`}
              </div>
            </div>
            <div className="card">
              <div className="metric-label">Planned hires</div>
              <div className="metric-value">{fmtInt(plannedHires)}</div>
              <div className="metric-sub">
                {hireClasses.length} class{hireClasses.length === 1 ? '' : 'es'}
                {suggestions && suggestions.length > 0 ? `, +${fmtInt(suggestedHires)} suggested` : ''}
              </div>
            </div>
            <div className="card">
              <div className="metric-label">Worst projected SL week</div>
              <div
                className="metric-value"
                style={worstSlWeek.projectedSl < staffing.slPct / 100 ? { color: 'var(--bad)' } : undefined}
              >
                {fmtPct(worstSlWeek.projectedSl)}
              </div>
              <div className="metric-sub">
                week of {fmtDateShort(worstSlWeek.week)}, target {fmtPct(staffing.slPct / 100, 0)}
              </div>
            </div>
          </div>
        )}

        {plan && scenario !== 'base' && basePlan && worstWeek && baseWorst !== null && (
          <div className="card scenario-strip">
            <span className="badge">Base vs {scenario}</span>
            <span className="note">
              Peak under-coverage: {fmtNum(Math.min(baseWorst, 0), 1)} base vs{' '}
              {fmtNum(Math.min(worstWeek.overUnder, 0), 1)} {scenario} (
              {fmtSigned(Math.min(worstWeek.overUnder, 0) - Math.min(baseWorst, 0), 1)} FTE).
              Planned hires: {fmtInt(plannedHires)} in both; classes are shared, only the
              assumption overrides differ.
            </span>
          </div>
        )}

        {plan && (
          <div className="card">
            <div className="card-title">
              <h2>Supply vs required FTE</h2>
              <span className="card-subtitle">
                Shaded green where supply covers demand, red where it falls short; dashed lines
                mark hire class starts and graduations
              </span>
            </div>
            <CapacityChart weeks={plan.weeks} hireClasses={hireClasses} theme={theme} />
          </div>
        )}

        {plan && (
          <HireClassesCard
            hireClasses={hireClasses}
            suggestions={suggestions}
            planMondays={planMondays}
            onAdd={addClass}
            onRemove={removeClass}
            onPatch={patchClass}
            onAcceptAll={acceptAll}
            onDismissSuggestions={() => setSuggestions(null)}
          />
        )}

        {plan && (
          <div className="card">
            <div className="card-title">
              <h2>Weekly plan grid</h2>
              <span className="card-subtitle">
                Volume, AHT, and shrinkage cells are editable; edits commit on Enter or blur and
                recompute the plan
              </span>
            </div>
            <CapacityGrid
              weeks={plan.weeks}
              shrinkageOf={shrinkageOf}
              volumeEdited={(w) => volumeOverrides.has(w)}
              ahtEdited={(w) => ahtOverrides.has(w)}
              shrinkageEdited={(w) => shrinkageByWeek.has(w)}
              slTarget={staffing.slPct / 100}
              onVolume={(w, v) => setVolumeOverrides((prev) => new Map(prev).set(w, v))}
              onAht={(w, v) => setAhtOverrides((prev) => new Map(prev).set(w, v))}
              onShrinkage={(w, v) => setShrinkageByWeek((prev) => new Map(prev).set(w, v))}
            />
          </div>
        )}

        {plan && (
          <SensitivityCard
            rows={sensRows}
            running={sensRunning}
            progress={sensProgress}
            currentWorst={worstWeek ? worstWeek.overUnder : null}
            onCompute={computeSensitivity}
          />
        )}
      </div>
    </div>
  )
}
