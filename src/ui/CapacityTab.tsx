import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCapacityPlan, capacitySensitivity, CAPACITY_LIMITS, SENSITIVITY_ATTRITION_POINTS, SENSITIVITY_DEMAND_CHANGE, SENSITIVITY_HIRE_SIZE_CHANGE, SENSITIVITY_SHRINKAGE_POINTS } from '../engine/capacity'
import type { CapacityConfig, CapacityPlan, CapacitySensitivity, HiringClassWeek, SensitivityRow } from '../engine/capacity'
import { firstPlanMonday, HISTORY_SEED_MAX_WEEKLY_GROWTH } from '../engine/capacitySeed'
import { usHolidays } from '../engine/holidays'
import { addDays, dayNumFromIso, isoFromDayNum, weekdayOfIso } from '../engine/series'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { IntervalRecord } from '../engine/types'
import type { ChartTheme } from './theme'
import { CapacityChart } from './charts/CapacityChart'
import { capacityConfig, capacityCsv, capacitySeedStaffing, exampleCapacityState, seedCapacityState, seedCapacityStateFromHistory, seedGrowth } from './capacityState'
import type { CapacityField, CapacitySource, CapacityState, HiringClassField } from './capacityState'
import { createStaffingSession, historySeedInWorker } from './workerClient'
import { downloadTextFile, fileSlug } from './download'
import { fmtNum, fmtPct, fmtSigned } from './format'
import { errorMessage } from './errors'

interface Spec { label: string; max: number; min?: number; step?: string }
const fields: (Spec & { key: Exclude<CapacityField, 'weeklyGrowthPct'> })[] = [
  { key: 'startingHeadcount', label: 'Starting paid headcount', max: 1000000 },
  { key: 'weeklyAttritionPct', label: 'Tenured weekly attrition (%)', max: 100 },
  { key: 'newHireAttritionPct', label: 'New-hire weekly attrition (%)', max: 100 },
  { key: 'paidHoursPerWeek', label: 'Paid hours per person per week', max: 168 },
  { key: 'shrinkagePct', label: 'Shrinkage (%)', max: 100 },
  { key: 'hourlyCost', label: 'Cost per paid hour', max: 100000 },
]
const classFields: (Spec & { key: HiringClassField })[] = [
  { key: 'size', label: 'Size (heads)', max: 1000000 },
  { key: 'startWeek', label: 'Start week', min: 1, max: 13, step: '1' },
  { key: 'trainingWeeks', label: 'Training weeks', max: 52, step: '1' },
  { key: 'nestingWeeks', label: 'Nesting weeks', max: 52, step: '1' },
  { key: 'nestingProductivityPct', label: 'Nesting productivity (%)', max: 100 },
  { key: 'rampWeeks', label: 'Ramp weeks', max: 52, step: '1' },
]
const growthSpec: Spec = { label: 'Weekly growth (%)', min: -HISTORY_SEED_MAX_WEEKLY_GROWTH * 100, max: HISTORY_SEED_MAX_WEEKLY_GROWTH * 100 }
const sourceLabels: Record<CapacitySource, string> = { unset: 'Enter an assumption', manual: 'Manual assumption', example: 'Illustrative example', forecast: 'Forecast seed', assumption: 'Repeated week assumption', history: 'History seed (same ISO week)', historyFallback: 'History seed (all-weeks mean fallback)' }
const phaseLabels: Record<HiringClassWeek['phase'], string> = { pending: '', training: 'training', nesting: 'nesting', ramp: 'ramp', productive: 'full productivity' }
const leverLabels: Record<SensitivityRow['lever'], string> = { demand: 'Demand (required productive FTE)', tenuredAttrition: 'Tenured weekly attrition', shrinkage: 'Shrinkage', newHireSize: 'Hiring class sizes' }
const balance = (n: number) => n < 0 ? `${fmtNum(-n, 2)} FTE short` : `${fmtNum(n, 2)} FTE surplus`
const shortage = (week: number | null) => week === null ? 'None in 13 weeks' : `Week ${week}`
const valid = (text: string, f: Spec) => {
  const value = Number(text)
  return text.trim() !== '' && Number.isFinite(value) && value >= (f.min ?? 0) && value <= f.max && (f.step !== '1' || Number.isInteger(value))
}
const rangeText = (f: Spec) => `Enter ${f.step === '1' ? 'a whole number' : 'a number'} from ${f.min ?? 0} to ${f.max}.`
const isMonday = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && isoFromDayNum(dayNumFromIso(date)) === date && weekdayOfIso(date) === 1
/** Signed, 2 decimals; float noise below display precision shows as +0.00. */
const signed = (n: number) => fmtSigned(Math.abs(n) < 0.005 ? 0 : n, 2)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A new class repeats the last class one week later, or starts from a 10-person class in week 2. */
function nextClass(state: CapacityState): Record<HiringClassField, string> {
  const last = state.classes.at(-1)
  if (!last) return { size: '10', startWeek: '2', trainingWeeks: '2', nestingWeeks: '0', nestingProductivityPct: '50', rampWeeks: '2' }
  const start = Number(last.startWeek)
  return { ...last, startWeek: valid(last.startWeek, classFields[1]) ? String(Math.min(13, start + 1)) : '2' }
}

function shortageChange(row: SensitivityRow, base: number | null) {
  if (row.firstShortageWeekDelta === null) {
    if (base === null && row.scenario.firstShortageWeek === null) return 'No shortage either way'
    return base === null ? 'New shortage' : 'Shortage cleared'
  }
  const d = row.firstShortageWeekDelta
  return d === 0 ? 'Same week' : `${plural(Math.abs(d), 'week')} ${d > 0 ? 'later' : 'earlier'}`
}

function leverChange(row: SensitivityRow, config: CapacityConfig) {
  const sign = row.direction === 'up' ? '+' : '-'
  const points = (step: number, current: number) => {
    const limit = Math.abs(row.value - (current + (row.direction === 'up' ? step : -step))) > 1e-12 ? ', limit' : ''
    return `${sign}${step * 100} points (to ${fmtPct(row.value)}${limit})`
  }
  switch (row.lever) {
    case 'demand': return `${sign}${SENSITIVITY_DEMAND_CHANGE * 100}% every week`
    case 'tenuredAttrition': return points(SENSITIVITY_ATTRITION_POINTS, config.weeklyAttrition)
    case 'shrinkage': return points(SENSITIVITY_SHRINKAGE_POINTS, config.shrinkage)
    case 'newHireSize': return `${sign}${SENSITIVITY_HIRE_SIZE_CHANGE * 100}% every class`
  }
}

function classPhases(plan: CapacityPlan | null, week: number) {
  const row = plan?.weeks[week]
  if (!row) return 'n/a'
  const text = row.classes.flatMap((c, i) => c.phase === 'pending' || c.headcount <= 0 ? []
    : [`C${i + 1} ${phaseLabels[c.phase]}${c.phase === 'nesting' || c.phase === 'ramp' ? ` (${fmtPct(c.productivity, 0)})` : ''}`])
  return text.length ? text.join(', ') : 'None'
}

function holidayNote(state: CapacityState, i: number) {
  const source = state.sources[i]
  if (!state.holidayMismatch[i] || !state.startDate || (source !== 'history' && source !== 'historyFallback')) return null
  const start = addDays(state.startDate, i * 7)
  const planHoliday = usHolidays(start, addDays(start, 6)).length > 0
  return planHoliday
    ? `Review: this plan week has a federal holiday; ${source === 'history' ? 'its history weeks do not' : 'the all-weeks mean carries no holiday'}.`
    : 'Review: its history weeks had a federal holiday; this plan week does not.'
}

export function CapacityTab({ queue, records, forecast, state, onChange, theme }: {
  queue: string; records: IntervalRecord[]; forecast: ForecastResult | null; state: CapacityState; onChange: (state: CapacityState) => void; theme: ChartTheme
}) {
  const [busy, setBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  const defaultPlanStart = useMemo(() => { try { return firstPlanMonday(records, queue) } catch { return '' } }, [records, queue])
  const [planStart, setPlanStart] = useState(() => state.startDate && state.sources.some(s => s === 'history' || s === 'historyFallback') ? state.startDate : defaultPlanStart)
  const [sensitivity, setSensitivity] = useState<{ key: string; result: CapacitySensitivity } | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  // Stable row keys for class rows live here only; saved plans carry no class ids.
  // A class list of a different length (example, opened project) gets fresh keys.
  const [classKeys, setClassKeys] = useState(() => ({ keys: state.classes.map((_, i) => i), next: state.classes.length }))
  if (classKeys.keys.length !== state.classes.length) setClassKeys({ keys: state.classes.map((_, i) => classKeys.next + i), next: classKeys.next + state.classes.length })
  const addClassButton = useRef<HTMLButtonElement>(null)
  const removeButtons = useRef(new Map<number, HTMLButtonElement>())
  const pendingFocus = useRef<number | 'add' | null>(null)
  useEffect(() => {
    if (pendingFocus.current === null) return
    const target = pendingFocus.current === 'add' ? addClassButton.current : removeButtons.current.get(pendingFocus.current)
    pendingFocus.current = null
    target?.focus()
  })
  const addClass = () => {
    setClassKeys({ keys: [...classKeys.keys, classKeys.next], next: classKeys.next + 1 })
    onChange({ ...state, classes: [...state.classes, nextClass(state)] })
  }
  const removeClass = (index: number, event: React.MouseEvent) => {
    // The second click of a double click lands on the row that moved up; ignore it.
    if (event.detail > 1) return
    // Focus the previous row's Remove (or Add) so a repeated key press cannot remove the next class.
    pendingFocus.current = index > 0 ? classKeys.keys[index - 1] : 'add'
    setClassKeys({ keys: classKeys.keys.filter((_, j) => j !== index), next: classKeys.next })
    onChange({ ...state, classes: state.classes.filter((_, j) => j !== index) })
  }
  let config: CapacityConfig | null = null, plan: CapacityPlan | null = null
  try { config = capacityConfig(state); plan = buildCapacityPlan(config) } catch { /* Invalid drafts have no computed output. */ }
  const configKey = config ? JSON.stringify(config) : null
  const hoursValid = valid(state.inputs.paidHoursPerWeek, fields[3]) && Number(state.inputs.paidHoursPerWeek) > 0
  const validField = (f: typeof fields[number]) => valid(state.inputs[f.key], f) && (f.key !== 'paidHoursPerWeek' || hoursValid)
  const growthValid = valid(state.inputs.weeklyGrowthPct, growthSpec)
  const planStartValid = isMonday(planStart)
  const setInput = (key: CapacityField, value: string) => onChange({ ...state, inputs: { ...state.inputs, [key]: value } })
  const setClass = (index: number, key: HiringClassField, value: string) => onChange({ ...state, classes: state.classes.map((c, i) => i === index ? { ...c, [key]: value } : c) })
  const run = async (task: () => Promise<CapacityState>) => {
    setBusy(true); setSeedError(null)
    try {
      const next = await task()
      if (live.current) onChange(next)
    } catch (error) { if (live.current) setSeedError(errorMessage(error)) }
    finally { if (live.current) setBusy(false) }
  }
  const seed = () => forecast && run(async () => {
    const { scenario, config } = capacitySeedStaffing(queue, forecast.intervalForecast)
    const grid = await createStaffingSession()(forecast.intervalForecast, scenario, config)
    return seedCapacityState(state, grid, forecast.dailyForecast.map(d => d.date))
  })
  const seedHistory = () => run(async () => {
    const history = await historySeedInWorker(records, queue, planStart, seedGrowth(state))
    const { scenario, config } = capacitySeedStaffing(queue, history.intervalForecast)
    const grid = await createStaffingSession()(history.intervalForecast, scenario, config)
    return seedCapacityStateFromHistory(state, grid, history)
  })
  const sensitivityCurrent = sensitivity && sensitivity.key === configKey ? sensitivity.result : null
  return <div className="stack capacity-panel">
    <div className="card">
      <div className="card-title"><h2>13-week capacity plan: {queue}</h2></div>
      <p>One productive FTE is one person's paid workweek spent on contacts, after breaks and other shrinkage.</p>
      <p className="note">Seed demand from the selected forecast or from the same weeks of past years, load the illustrative hiring example, or enter all 13 weekly demand assumptions below.</p>
      <div className="row">
        <button className="btn" disabled={busy || !forecast || !hoursValid} onClick={seed}>{busy ? 'Seeding demand...' : 'Seed demand from selected forecast'}</button>
        <button className="btn" disabled={busy} onClick={() => { setSeedError(null); onChange(exampleCapacityState()) }}>Load illustrative hiring example</button>
      </div>
      <fieldset className="capacity-history-seed" disabled={busy}>
        <legend>Seed from history</legend>
        <div className="capacity-history-inputs">
          <div>
            <label htmlFor="capacity-plan-start">Plan start (Monday)</label>
            <input id="capacity-plan-start" className="num-input" type="date" value={planStart} aria-invalid={!planStartValid} aria-describedby={planStartValid ? undefined : 'capacity-error-plan-start'} onChange={e => setPlanStart(e.target.value)} />
            {!planStartValid && <span id="capacity-error-plan-start" className="error-text">Choose a Monday.</span>}
          </div>
          <div>
            <label htmlFor="capacity-weeklyGrowthPct">{growthSpec.label}</label>
            <input id="capacity-weeklyGrowthPct" className="num-input" type="number" min={growthSpec.min} max={growthSpec.max} step="any" value={state.inputs.weeklyGrowthPct} aria-invalid={!growthValid} aria-describedby={growthValid ? undefined : 'capacity-error-weeklyGrowthPct'} onChange={e => setInput('weeklyGrowthPct', e.target.value)} />
            {!growthValid && <span id="capacity-error-weeklyGrowthPct" className="error-text">{rangeText(growthSpec)}</span>}
          </div>
          <button className="btn" disabled={busy || !planStartValid || !growthValid || !hoursValid} onClick={seedHistory}>Seed demand from same week last year(s)</button>
        </div>
      </fieldset>
      <details className="capacity-seed-notes"><summary>Forecast seed assumptions</summary><p className="note">Forecast seed uses default staffing targets: Erlang A, 80% answered within 20 seconds, 120-second patience, 90% occupancy cap; chat queues use 2 concurrent chats. On-contact hours are divided by paid hours per week. Later weeks repeat the last complete forecast week as editable planning assumptions. These are not validated long-range forecasts.</p></details>
      <details className="capacity-seed-notes"><summary>History seed assumptions</summary><p className="note">Each plan week averages the complete Monday-to-Sunday history weeks with the same ISO week number before the plan start; each more recent year counts double. Weekly growth compounds once per week between a history week and the plan week, within ±{HISTORY_SEED_MAX_WEEKLY_GROWTH * 100}%. An ISO week with no history, such as week 53, uses the mean of all history weeks and is labeled as a fallback. Holiday weeks stay in. A week is marked for review when the plan week and its same-week history disagree on containing a US federal holiday. Holiday closures are not zeroed. Staffing uses the same default targets as the forecast seed.</p></details>
      {state.seedPaidHours !== null && <p className="note">Demand was seeded at {state.seedPaidHours} paid hours per week{state.seedGrowthPct !== null && ` with ${fmtNum(state.seedGrowthPct, 2)}% weekly growth`}. FTE entries stay fixed when hours, growth or the selected forecast change; use Seed demand again to refresh them.</p>}
      {state.sources.includes('example') && <p className="note">Illustrative example only: 100 starting heads, demand rises in week 7, and 10 hires arrive in week 2.</p>}
      {seedError && <p role="alert" className="error-text">{seedError}</p>}
    </div>
    {plan && <div className="cards-row capacity-summary">
      <div className="card"><div className="metric-label">Baseline first shortage</div><div className="metric-value">{shortage(plan.baseline.firstShortageWeek)}</div><div>13-week paid cost: {fmtNum(plan.baseline.totalCost, 2)}</div></div>
      <div className="card"><div className="metric-label">Proposed first shortage</div><div className="metric-value">{shortage(plan.scenario.firstShortageWeek)}</div><div>13-week paid cost: {fmtNum(plan.scenario.totalCost, 2)}</div></div>
      <div className="card"><div className="metric-label">Additional paid cost</div><div className="metric-value">{fmtNum(plan.incrementalCost, 2)}</div><div>Proposed classes minus baseline, 13 weeks</div></div>
    </div>}
    <fieldset className="card capacity-controls" disabled={busy}>
      <legend>Supply assumptions</legend>
      <div className="capacity-input-grid">{fields.map(f => <div key={f.key}>
        <label htmlFor={`capacity-${f.key}`}>{f.label}</label>
        <input id={`capacity-${f.key}`} className="num-input" type="number" min={f.min ?? 0} max={f.max} step={f.step ?? 'any'} value={state.inputs[f.key]} aria-invalid={!validField(f)} aria-describedby={!validField(f) ? `capacity-error-${f.key}` : undefined}
          onChange={e => setInput(f.key, e.target.value)} />
        {!validField(f) && <span id={`capacity-error-${f.key}`} className="error-text">{f.key === 'paidHoursPerWeek' ? `Enter a number greater than 0 to ${f.max}.` : rangeText(f)}</span>}
      </div>)}</div>
      <p className="note">Tenured attrition applies to starting headcount from week 2. New-hire attrition applies to every class from the week after it starts, through week 13. Fractional headcounts represent expected survivors. Cost uses your own currency units, excluding benefits and overtime.</p>
    </fieldset>
    <fieldset className="card capacity-controls" disabled={busy}>
      <legend>Hiring classes</legend>
      <div className="row capacity-class-actions">
        <button ref={addClassButton} className="btn" disabled={state.classes.length >= CAPACITY_LIMITS.hiringClasses} onClick={addClass}>Add hiring class</button>
        <span className="note">{state.classes.length} of {CAPACITY_LIMITS.hiringClasses} classes</span>
      </div>
      {state.classes.length === 0 ? <p className="note">No hiring classes: the proposal equals the baseline. Add a class to test hiring.</p>
        /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the wide class table */
        : <div className="table-wrap" tabIndex={0} role="region" aria-label="Hiring class inputs"><table className="table capacity-class-table">
          <thead><tr><th scope="col">Class</th>{classFields.map(f => <th scope="col" key={f.key}>{f.label}</th>)}<th scope="col">Production start</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>{state.classes.map((c, i) => {
            const n = i + 1
            const timing = ['startWeek', 'trainingWeeks', 'nestingWeeks'] as const
            const production = timing.every(k => valid(c[k], classFields.find(f => f.key === k)!)) ? Number(c.startWeek) + Number(c.trainingWeeks) + Number(c.nestingWeeks) : null
            const key = classKeys.keys[i] ?? -1 - i
            return <tr key={key}><th scope="row">Class {n}</th>
              {classFields.map(f => {
                const ok = valid(c[f.key], f), id = `capacity-class-${i}-${f.key}`
                return <td key={f.key}><input id={id} className="num-input" type="number" min={f.min ?? 0} max={f.max} step={f.step ?? 'any'} value={c[f.key]} aria-label={`Class ${n} ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`} aria-invalid={!ok} aria-describedby={ok ? undefined : `${id}-error`}
                  onChange={e => setClass(i, f.key, e.target.value)} />{!ok && <small id={`${id}-error`} className="error-text">{rangeText(f)}</small>}</td>
              })}
              <td>{production === null ? 'n/a' : production > 13 ? 'After week 13' : `Week ${production}`}</td>
              <td><button ref={el => { if (el) removeButtons.current.set(key, el); else removeButtons.current.delete(key) }} className="btn" aria-label={`Remove class ${n}`} onClick={e => removeClass(i, e)}>Remove</button></td></tr>
          })}</tbody>
        </table></div>}
      <p className="note">Each class is paid from its start week. Training weeks supply no productive time. Nesting weeks supply each surviving hire at the nesting productivity. Ramp weeks then rise evenly from the nesting productivity (or from zero without nesting) to full productivity. Production start is the first week after training and nesting. Size 0 turns a class off.</p>
    </fieldset>
    {!plan && <p role="status">Complete valid assumptions and all 13 demand entries to show results. Blank demand is missing; enter 0 for no demand.</p>}
    {plan && <div className="card"><div className="card-title"><h2>Weekly productive FTE</h2></div><CapacityChart plan={plan} theme={theme} />
      {state.classes.length > 0 && <p className="note">Dashed vertical lines mark hiring classes: "C1 start" is class 1's start week and "C1 prod" its production start. Line labels are hidden on narrow screens; the class table lists both weeks.</p>}</div>}
    <div className="card">
      <div className="card-title"><h2>Weekly demand and capacity</h2><button className="btn" disabled={!plan || busy} onClick={() => plan && downloadTextFile(`capacity-${fileSlug(queue)}.csv`, capacityCsv(plan, state))}>Download capacity CSV</button></div>
      <p className="note">Surplus means supply exceeds demand; short means demand exceeds supply. Class phases show productivity per surviving hire. Display rounds to 2 decimals; CSV retains full values.</p>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the wide numeric table */}
      <div className="scroll" tabIndex={0} role="region" aria-label="13-week editable capacity table"><table className="table capacity-table">
        <thead><tr><th scope="col">Week / start</th><th scope="col">Demand source</th><th scope="col">Required productive FTE</th><th scope="col">Baseline FTE</th><th scope="col">Proposed FTE</th><th scope="col">Baseline balance</th><th scope="col">Proposed balance</th><th scope="col">Baseline paid cost</th><th scope="col">Proposed paid cost</th><th scope="col">Class phases</th></tr></thead>
        <tbody>{state.demand.map((d, i) => {
          const row = plan?.weeks[i]
          const invalid = d.trim() === '' || !Number.isFinite(Number(d)) || Number(d) < 0 || Number(d) > 1000000
          const review = holidayNote(state, i)
          return <tr key={i}><th scope="row">Week {i + 1}{state.startDate && <small>{addDays(state.startDate, i * 7)}</small>}</th><td className="capacity-source">{sourceLabels[state.sources[i]]}{review && <small className="capacity-review">{review}</small>}</td>
            <td><input className="num-input" type="number" min={0} max={1000000} step="any" disabled={busy} aria-label={`Week ${i + 1} required productive FTE`} aria-invalid={invalid} aria-describedby={invalid ? `capacity-week-${i}-error` : undefined} value={d} onChange={e => onChange({ ...state, demand: state.demand.map((v, j) => j === i ? e.target.value : v), sources: state.sources.map((v, j) => j === i ? 'manual' : v), holidayMismatch: state.holidayMismatch.map((v, j) => j === i ? false : v) })} />{invalid && <small id={`capacity-week-${i}-error`} className="error-text">Enter 0 to 1,000,000.</small>}</td>
            <td>{row ? fmtNum(row.baseline.productiveFte, 2) : 'n/a'}</td><td>{row ? fmtNum(row.scenario.productiveFte, 2) : 'n/a'}</td><td>{row ? balance(row.baseline.balanceFte) : 'n/a'}</td><td>{row ? balance(row.scenario.balanceFte) : 'n/a'}</td><td>{row ? fmtNum(row.baseline.cost, 2) : 'n/a'}</td><td>{row ? fmtNum(row.scenario.cost, 2) : 'n/a'}</td><td className="capacity-phases">{classPhases(plan, i)}</td></tr>
        })}</tbody>
      </table></div>
    </div>
    <div className="card">
      <div className="card-title"><h2>Sensitivity</h2><button className="btn" disabled={!config || busy} onClick={() => config && configKey && setSensitivity({ key: configKey, result: capacitySensitivity(config) })}>Run sensitivity</button></div>
      <p className="note">Reruns the proposal with one lever changed at a time, down and up; every other assumption stays as entered, and levers are not combined. Attrition stays within 0 to 100% and shrinkage within 0 to 99%. Shortage FTE-weeks is weekly FTE short summed over 13 weeks.</p>
      {sensitivity && !sensitivityCurrent && <p role="status">Assumptions changed after the last run. Run sensitivity again to update the table.</p>}
      {sensitivityCurrent && config && <>
        <p>Current proposal: first shortage {shortage(sensitivityCurrent.scenario.firstShortageWeek).toLowerCase()}, {fmtNum(sensitivityCurrent.scenario.totalShortageFteWeeks, 2)} shortage FTE-weeks, 13-week paid cost {fmtNum(sensitivityCurrent.scenario.totalCost, 2)}.</p>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the wide sensitivity table */}
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Sensitivity table"><table className="table capacity-sensitivity">
          <thead><tr><th scope="col">Lever</th><th scope="col">Change</th><th scope="col">First shortage</th><th scope="col">First shortage change</th><th scope="col" className="num">Shortage FTE-weeks</th><th scope="col" className="num">Shortage FTE-weeks change</th><th scope="col" className="num">13-week paid cost</th><th scope="col" className="num">Cost change</th></tr></thead>
          <tbody>{sensitivityCurrent.rows.map(row => <tr key={row.lever + row.direction}>
            <th scope="row">{leverLabels[row.lever]}</th><td>{leverChange(row, config)}</td><td>{shortage(row.scenario.firstShortageWeek)}</td><td>{shortageChange(row, sensitivityCurrent.scenario.firstShortageWeek)}</td>
            <td className="num">{fmtNum(row.scenario.totalShortageFteWeeks, 2)}</td><td className="num">{signed(row.totalShortageFteWeeksDelta)}</td><td className="num">{fmtNum(row.scenario.totalCost, 2)}</td><td className="num">{signed(row.totalCostDelta)}</td></tr>)}</tbody>
        </table></div>
      </>}
    </div>
  </div>
}
