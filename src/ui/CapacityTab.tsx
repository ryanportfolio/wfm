import { useEffect, useRef, useState } from 'react'
import { buildCapacityPlan } from '../engine/capacity'
import { addDays } from '../engine/series'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { ChartTheme } from './theme'
import { CapacityChart } from './charts/CapacityChart'
import { capacityConfig, capacityCsv, exampleCapacityState, seedCapacityState } from './capacityState'
import type { CapacityField, CapacityState } from './capacityState'
import { createStaffingSession } from './workerClient'
import { DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'
import { downloadTextFile, fileSlug } from './download'
import { fmtNum } from './format'
import { errorMessage } from './errors'
import { deriveIntervalSec } from './staffingInterval'

const fields: { key: CapacityField; label: string; max: number; min?: number; step?: string }[] = [
  { key: 'startingHeadcount', label: 'Starting paid headcount', max: 1000000 },
  { key: 'weeklyAttritionPct', label: 'Weekly attrition (%)', max: 100 },
  { key: 'paidHoursPerWeek', label: 'Paid hours per person per week', max: 168 },
  { key: 'shrinkagePct', label: 'Shrinkage (%)', max: 100 },
  { key: 'hourlyCost', label: 'Cost per paid hour', max: 100000 },
  { key: 'classSize', label: 'Proposed class size', max: 1000000 },
  { key: 'startWeek', label: 'Class start week', min: 1, max: 13, step: '1' },
  { key: 'trainingWeeks', label: 'Full training weeks', max: 52, step: '1' },
  { key: 'rampWeeks', label: 'Ramp weeks', max: 52, step: '1' },
]
const sourceLabels = { unset: 'Enter an assumption', manual: 'Manual assumption', example: 'Illustrative example', forecast: 'Forecast seed', assumption: 'Repeated week assumption' }
const balance = (n: number) => n < 0 ? `${fmtNum(-n, 2)} FTE short` : `${fmtNum(n, 2)} FTE surplus`
const shortage = (week: number | null) => week === null ? 'None in 13 weeks' : `Week ${week}`

export function CapacityTab({ queue, forecast, state, onChange, theme }: {
  queue: string; forecast: ForecastResult | null; state: CapacityState; onChange: (state: CapacityState) => void; theme: ChartTheme
}) {
  const [busy, setBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  let plan = null
  try { plan = buildCapacityPlan(capacityConfig(state)) } catch { /* Invalid drafts have no computed output. */ }
  const validField = (f: typeof fields[number]) => {
    const text = state.inputs[f.key], value = Number(text)
    return text.trim() !== '' && Number.isFinite(value) && value >= (f.min ?? 0) && value <= f.max && (f.step !== '1' || Number.isInteger(value)) && (f.key !== 'paidHoursPerWeek' || value > 0)
  }
  const seed = async () => {
    if (!forecast) return
    setBusy(true); setSeedError(null)
    try {
      const scenario = toEngineScenario(DEFAULT_SCENARIO, queue.toLowerCase().includes('chat'))
      const grid = await createStaffingSession()(forecast.intervalForecast, scenario, {
        mode: 'erlangA', slPct: 0.8, slSeconds: 20, patienceSec: 120, shrinkage: 0.3, intervalSec: deriveIntervalSec(forecast.intervalForecast), queue,
      })
      const next = seedCapacityState(state, grid, forecast.dailyForecast.map(d => d.date))
      if (live.current) onChange(next)
    } catch (error) { if (live.current) setSeedError(errorMessage(error)) }
    finally { if (live.current) setBusy(false) }
  }
  return <div className="stack capacity-panel">
    <div className="card">
      <div className="card-title"><h2>13-week capacity plan: {queue}</h2></div>
      <p>One productive FTE is one person's paid workweek spent on contacts, after breaks and other shrinkage.</p>
      <p className="note">Seed from the selected forecast, load the illustrative hiring example, or enter all 13 weekly demand assumptions below.</p>
      <div className="row">
        <button className="btn" disabled={busy || !forecast || !validField(fields[2])} onClick={seed}>{busy ? 'Seeding demand...' : 'Seed demand from selected forecast'}</button>
        <button className="btn" disabled={busy} onClick={() => { setSeedError(null); onChange(exampleCapacityState()) }}>Load illustrative hiring example</button>
      </div>
      <details className="capacity-seed-notes"><summary>Forecast seed assumptions</summary><p className="note">Forecast seed uses default staffing targets: Erlang A, 80% answered within 20 seconds, 120-second patience, 90% occupancy cap; chat queues use 2 concurrent chats. On-contact hours are divided by paid hours per week. Later weeks repeat the last complete forecast week as editable planning assumptions. These are not validated long-range forecasts.</p></details>
      {state.seedPaidHours !== null && <p className="note">Demand was seeded at {state.seedPaidHours} paid hours per week. FTE entries stay fixed when hours or the selected forecast change; use Seed demand again to refresh them.</p>}
      {state.sources.includes('example') && <p className="note">Illustrative example only: 100 starting heads, demand rises in week 7, and 10 hires arrive in week 2.</p>}
      {seedError && <p role="alert" className="error-text">{seedError}</p>}
    </div>
    {plan && <div className="cards-row capacity-summary">
      <div className="card"><div className="metric-label">Baseline first shortage</div><div className="metric-value">{shortage(plan.baseline.firstShortageWeek)}</div><div>13-week paid cost: {fmtNum(plan.baseline.totalCost, 2)}</div></div>
      <div className="card"><div className="metric-label">Proposed first shortage</div><div className="metric-value">{shortage(plan.scenario.firstShortageWeek)}</div><div>13-week paid cost: {fmtNum(plan.scenario.totalCost, 2)}</div></div>
      <div className="card"><div className="metric-label">Additional paid cost</div><div className="metric-value">{fmtNum(plan.incrementalCost, 2)}</div><div>Proposed class minus baseline, 13 weeks</div></div>
    </div>}
    <fieldset className="card capacity-controls" disabled={busy}>
      <legend>Supply and hiring assumptions</legend>
      <div className="capacity-input-grid">{fields.map(f => <div key={f.key}>
        <label htmlFor={`capacity-${f.key}`}>{f.label}</label>
        <input id={`capacity-${f.key}`} className="num-input" type="number" min={f.min ?? 0} max={f.max} step={f.step ?? 'any'} value={state.inputs[f.key]} aria-invalid={!validField(f)} aria-describedby={!validField(f) ? `capacity-error-${f.key}` : undefined}
          onChange={e => onChange({ ...state, inputs: { ...state.inputs, [f.key]: e.target.value } })} />
        {!validField(f) && <span id={`capacity-error-${f.key}`} className="error-text">Enter {f.step === '1' ? 'a whole number' : 'a number'} {f.key === 'paidHoursPerWeek' ? 'greater than 0' : `from ${f.min ?? 0}`} to {f.max}.</span>}
      </div>)}</div>
      <p className="note">Attrition starts in week 2 and also applies to hires after arrival. Hires are paid during full training weeks, then ramp evenly to full productivity. Fractional headcounts represent expected survivors. Cost uses your own currency units, excluding benefits and overtime.</p>
    </fieldset>
    {!plan && <p role="status">Complete valid assumptions and all 13 demand entries to show results. Blank demand is missing; enter 0 for no demand.</p>}
    {plan && <div className="card"><div className="card-title"><h2>Weekly productive FTE</h2></div><CapacityChart plan={plan} theme={theme} /></div>}
    <div className="card">
      <div className="card-title"><h2>Weekly demand and capacity</h2><button className="btn" disabled={!plan || busy} onClick={() => plan && downloadTextFile(`capacity-${fileSlug(queue)}.csv`, capacityCsv(plan, state))}>Download capacity CSV</button></div>
      <p className="note">Surplus means supply exceeds demand; short means demand exceeds supply. Display rounds to 2 decimals; CSV retains full values.</p>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the wide numeric table */}
      <div className="scroll" tabIndex={0} role="region" aria-label="13-week editable capacity table"><table className="table capacity-table">
        <thead><tr><th scope="col">Week / start</th><th scope="col">Demand source</th><th scope="col">Required productive FTE</th><th scope="col">Baseline FTE</th><th scope="col">Proposed FTE</th><th scope="col">Baseline balance</th><th scope="col">Proposed balance</th><th scope="col">Baseline paid cost</th><th scope="col">Proposed paid cost</th></tr></thead>
        <tbody>{state.demand.map((d, i) => {
          const row = plan?.weeks[i]
          const invalid = d.trim() === '' || !Number.isFinite(Number(d)) || Number(d) < 0 || Number(d) > 1000000
          return <tr key={i}><th scope="row">Week {i + 1}{state.startDate && <small>{addDays(state.startDate, i * 7)}</small>}</th><td>{sourceLabels[state.sources[i]]}</td>
            <td><input className="num-input" type="number" min={0} max={1000000} step="any" disabled={busy} aria-label={`Week ${i + 1} required productive FTE`} aria-invalid={invalid} value={d} onChange={e => onChange({ ...state, demand: state.demand.map((v, j) => j === i ? e.target.value : v), sources: state.sources.map((v, j) => j === i ? 'manual' : v) })} />{invalid && <small className="error-text">Enter 0 to 1,000,000.</small>}</td>
            <td>{row ? fmtNum(row.baseline.productiveFte, 2) : 'n/a'}</td><td>{row ? fmtNum(row.scenario.productiveFte, 2) : 'n/a'}</td><td>{row ? balance(row.baseline.balanceFte) : 'n/a'}</td><td>{row ? balance(row.scenario.balanceFte) : 'n/a'}</td><td>{row ? fmtNum(row.baseline.cost, 2) : 'n/a'}</td><td>{row ? fmtNum(row.scenario.cost, 2) : 'n/a'}</td></tr>
        })}</tbody>
      </table></div>
    </div>
  </div>
}
