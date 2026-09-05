import { useEffect, useMemo, useState } from 'react'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { IntradayInputs, IntradayResult } from '../engine/intraday'
import { intradayCsv } from '../engine/intraday'
import type { StaffingConfig } from '../engine/staffing'
import type { ScenarioState } from './controls/ScenarioPanel'
import { toEngineScenario } from './controls/ScenarioPanel'
import type { IntradayState } from './intradayState'
import { emptyIntradayInputs } from './intradayState'
import { intradayInWorker } from './workerClient'
import { errorMessage } from './errors'
import { downloadTextFile, fileSlug } from './download'
import { IntradayChart } from './charts/IntradayChart'
import type { ChartTheme } from './theme'

interface Props { forecast: ForecastResult; queue: string; state: IntradayState; onChange: (state: IntradayState) => void; scenario: ScenarioState; theme: ChartTheme; active?: boolean }

export function IntradayTab({ forecast, queue, state, onChange, scenario, theme, active = true }: Props) {
  const dates = useMemo(() => [...new Set(forecast.intervalForecast.map(p => p.ts.slice(0, 10)))], [forecast])
  // An out-of-horizon selection remains saved so extending the horizon restores it.
  const date = state.selectedDay && dates.includes(state.selectedDay) ? state.selectedDay : dates[0] ?? ''
  const inputs = useMemo(() => Object.hasOwn(state.days, date) ? state.days[date] : emptyIntradayInputs(), [state.days, date])
  const points = useMemo(() => forecast.intervalForecast.filter(p => p.ts.startsWith(date + 'T')).map(p => ({ ...p, aht: p.aht * (1 + scenario.ahtDeltaPct / 100) })), [forecast, date, scenario.ahtDeltaPct])
  const config = useMemo<StaffingConfig>(() => {
    const s = toEngineScenario(scenario, queue.toLowerCase().includes('chat'))
    return { mode: scenario.mode, slPct: scenario.slPct / 100, slSeconds: scenario.slSeconds, patienceSec: scenario.patienceSec, shrinkage: scenario.shrinkagePct / 100, occupancyCap: s.occupancyCap, maxAbandonPct: s.maxAbandonPct, chatConcurrency: s.chatConcurrency, intervalSec: 1800, queue }
  }, [scenario, queue])
  const request = useMemo(() => ({ points, inputs, config }), [points, inputs, config])
  const [settled, setSettled] = useState<{ request: typeof request; result?: IntradayResult; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      intradayInWorker(request.points, request.inputs, request.config, controller.signal).then(result => {
        if (!controller.signal.aborted) setSettled({ request, result })
      }).catch(err => { if (!controller.signal.aborted) setSettled({ request, error: errorMessage(err) }) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [request, attempt, active])
  const live = settled?.request === request ? settled : null
  const result = live?.result
  const update = (patch: Partial<IntradayInputs>) => onChange({ ...state, selectedDay: date, days: { ...state.days, [date]: { ...inputs, ...patch } } })
  if (!date) return <div className="card"><h2>Intraday reforecast</h2><p>No forecast intervals are available.</p></div>
  if (points.length > 48) return <div className="card"><h2>Intraday reforecast</h2><p role="alert">This forecast has more than 48 intervals per day. Intraday supports half-hour intervals only.</p></div>
  return <div className="card">
    <h2>Intraday reforecast</h2>
    <p className="note">Enter actual contacts for every elapsed interval. Remaining demand scales by cumulative actual contacts divided by cumulative baseline contacts. Zero is an observation; a blank is missing.</p>
    <div className="intraday-controls">
      <label>Forecast day <select value={date} onChange={e => onChange({ ...state, selectedDay: e.target.value })}>{dates.map(d => <option key={d}>{d}</option>)}</select></label>
      <label>Observed through <select value={inputs.cutoff} onChange={e => update({ cutoff: Number(e.target.value) })}>
        <option value={0}>No elapsed intervals</option>
        {points.map((p, i) => <option key={p.ts} value={i + 1}>{p.ts.slice(11, 16)} interval ({i + 1} elapsed)</option>)}
      </select></label>
    </div>
    <p className="note">Baseline uses the original forecast volume. Staffing uses scenario A: {config.mode === 'erlangA' ? 'Erlang A' : 'Erlang C'}, {scenario.slPct}% within {scenario.slSeconds}s, {scenario.shrinkagePct}% shrinkage, {config.chatConcurrency} contact(s) per agent, {scenario.ahtDeltaPct}% AHT adjustment{config.mode === 'erlangA' ? `, ${scenario.patienceSec}s patience` : ''}, {scenario.occupancyCapPct}% occupancy cap{config.maxAbandonPct !== undefined ? `, ${scenario.maxAbandonPct}% abandonment cap` : ''}. Change these assumptions in Staffing. Scenario volume adjustments do not change this baseline.</p>
    <p className="note">Scheduled heads default to 0. Shrinkage is applied once, then on-contact bodies are rounded down. Required bodies exclude shrinkage. Each half hour is a steady-state approximation; waiting callers are not carried into the next interval. Only :00 and :30 interval starts are supported. Calculations stop after 10 seconds. Limits: 48 intervals, 100,000 contacts, 500 scheduled heads and 100 Erlangs per interval.</p>
    {!live && <p role="status">Computing intraday comparison...</p>}
    {live?.error && <div role="alert"><p>{live.error} Comparison is incomplete.</p><button className="btn" onClick={() => { setSettled(null); setAttempt(a => a + 1) }}>Retry calculation</button></div>}
    {result && <>
      <p role="status">{inputs.cutoff === 0 ? 'No actuals entered. Original baseline retained.' : result.ratio === null ? 'Observed baseline is zero. Ratio unavailable; remaining baseline retained.' : `Observed ratio: ${result.ratio.toFixed(3)}.`} Baseline day: {result.baselineTotal.toFixed(1)} contacts. Revised day: {result.revisedTotal.toFixed(1)} contacts.</p>
      <button className="btn" onClick={() => downloadTextFile(`${fileSlug(queue)}-${date}-intraday.csv`, intradayCsv(result))}>Export intraday CSV</button>
      <IntradayChart result={result} theme={theme} />
    </>}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to focus this horizontally scrolling table */}
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Intraday interval comparison">
      <table className="table"><caption>Interval contacts and staffing for {queue}, {date}</caption>
        <thead><tr>{['Interval', 'Status', 'Baseline contacts', 'Actual contacts', 'Revised contacts', 'Scheduled heads', 'Baseline required bodies', 'Revised required bodies', 'Baseline SL', 'Revised SL'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{points.map((p, i) => {
          const row = result?.rows[i]
          return <tr key={p.ts}>
            <th scope="row">{p.ts.slice(11, 16)}</th><td>{i < inputs.cutoff ? 'Observed' : 'Remaining'}</td><td>{p.offered.toFixed(1)}</td>
            <td><input className="num-input" type="number" min="0" max="100000" step="any" aria-label={`Actual contacts ${p.ts.slice(11, 16)}`} disabled={i >= inputs.cutoff} value={i < inputs.cutoff ? inputs.actuals[p.ts] ?? '' : ''} onChange={e => update({ actuals: { ...inputs.actuals, [p.ts]: e.target.value } })} /></td>
            <td>{row?.revised.toFixed(1) ?? 'n/a'}</td>
            <td><input className="num-input" type="number" min="0" max="500" step="any" aria-label={`Scheduled heads ${p.ts.slice(11, 16)}`} value={inputs.scheduled[p.ts] ?? '0'} onChange={e => update({ scheduled: { ...inputs.scheduled, [p.ts]: e.target.value } })} /></td>
            <td>{row?.baselineRequired ?? 'n/a'}</td><td>{row?.revisedRequired ?? 'n/a'}</td><td>{row ? (row.baselineSl * 100).toFixed(1) + '%' : 'n/a'}</td><td>{row ? (row.revisedSl * 100).toFixed(1) + '%' : 'n/a'}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
  </div>
}
