import { useEffect, useMemo, useState } from 'react'
import type { ForecastPoint } from '../engine/types'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { StaffingConfig, StaffingGridResult } from '../engine/staffing'
import { applyScenario } from '../engine/staffing'
import type { ChartTheme } from './theme'
import { ScenarioPanel, DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'
import type { ScenarioState } from './controls/ScenarioPanel'
import { StaffingIntervalChart } from './charts/StaffingIntervalChart'
import type { StaffingRow } from './charts/StaffingIntervalChart'
import { fmtDateWeekday, fmtInt, fmtNum, fmtPct, fmtSec, fmtSigned } from './format'

interface StaffingTabProps {
  forecast: ForecastResult
  queue: string
  horizon: number
  theme: ChartTheme
}

interface DayRow {
  date: string
  contacts: number
  requiredFte: number
  scheduledFte: number
  peakRequired: number
  sl: number
  asa: number
  abandon: number
}

interface GridSummary {
  days: DayRow[]
  peakScheduled: number
  totalScheduledFte: number
  weightedOcc: number
}

function deriveIntervalSec(points: readonly ForecastPoint[]): number {
  if (points.length >= 2 && points[0].ts.slice(0, 10) === points[1].ts.slice(0, 10)) {
    const secOf = (ts: string) => Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60
    const diff = secOf(points[1].ts) - secOf(points[0].ts)
    if (diff > 0) return diff
  }
  return 1800
}

function summarize(
  grid: StaffingGridResult,
  forecastPoints: readonly ForecastPoint[],
  volumeDeltaPct: number,
): GridSummary {
  const scale = 1 + volumeDeltaPct / 100
  interface Acc extends DayRow {
    slW: number
    asaW: number
    abW: number
    w: number
  }
  const byDate = new Map<string, Acc>()
  let peakScheduled = 0
  let occW = 0
  let wSum = 0

  grid.intervals.forEach((iv, i) => {
    const offered = (forecastPoints[i]?.offered ?? 0) * scale
    const date = iv.ts.slice(0, 10)
    let d = byDate.get(date)
    if (!d) {
      d = {
        date,
        contacts: 0,
        requiredFte: 0,
        scheduledFte: 0,
        peakRequired: 0,
        sl: 0,
        asa: 0,
        abandon: 0,
        slW: 0,
        asaW: 0,
        abW: 0,
        w: 0,
      }
      byDate.set(date, d)
    }
    d.contacts += offered
    if (iv.required > d.peakRequired) d.peakRequired = iv.required
    d.slW += iv.serviceLevel * offered
    d.asaW += (Number.isFinite(iv.asa) ? iv.asa : 0) * offered
    d.abW += iv.abandonRate * offered
    d.w += offered
    if (iv.scheduled > peakScheduled) peakScheduled = iv.scheduled
    occW += iv.occupancy * offered
    wSum += offered
  })

  let totalScheduledFte = 0
  for (const day of grid.daily) {
    const d = byDate.get(day.date)
    if (d) {
      d.requiredFte = day.requiredFteHours
      d.scheduledFte = day.scheduledFteHours
    }
    totalScheduledFte += day.scheduledFteHours
  }

  const days = [...byDate.values()].map((d) => ({
    date: d.date,
    contacts: d.contacts,
    requiredFte: d.requiredFte,
    scheduledFte: d.scheduledFte,
    peakRequired: d.peakRequired,
    sl: d.w > 0 ? d.slW / d.w : 1,
    asa: d.w > 0 ? d.asaW / d.w : 0,
    abandon: d.w > 0 ? d.abW / d.w : 0,
  }))
  days.sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    days,
    peakScheduled,
    totalScheduledFte,
    weightedOcc: wSum > 0 ? occW / wSum : 0,
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

function useGrid(
  intervalForecast: readonly ForecastPoint[],
  state: ScenarioState | null,
  isChat: boolean,
  baseConfig: StaffingConfig,
): { grid: StaffingGridResult | null; computing: boolean } {
  const debounced = useDebounced(state, 150)
  const [grid, setGrid] = useState<StaffingGridResult | null>(null)
  const [computing, setComputing] = useState(false)

  useEffect(() => {
    if (!debounced) {
      setGrid(null)
      return
    }
    setComputing(true)
    // Yield so slider interaction stays responsive while Erlang math runs.
    const id = setTimeout(() => {
      setGrid(applyScenario(intervalForecast, toEngineScenario(debounced, isChat), baseConfig))
      setComputing(false)
    }, 0)
    return () => clearTimeout(id)
  }, [debounced, intervalForecast, isChat, baseConfig])

  return { grid, computing }
}

export function StaffingTab({ forecast, queue, horizon, theme }: StaffingTabProps) {
  const isChat = queue.toLowerCase().includes('chat')
  const intervalForecast = forecast.intervalForecast

  const baseConfig = useMemo<StaffingConfig>(
    () => ({
      mode: 'erlangA',
      slPct: 0.8,
      slSeconds: 20,
      patienceSec: 120,
      shrinkage: 0.3,
      intervalSec: deriveIntervalSec(intervalForecast),
      queue,
    }),
    [intervalForecast, queue],
  )

  const [stateA, setStateA] = useState<ScenarioState>(DEFAULT_SCENARIO)
  const [compare, setCompare] = useState(false)
  const [stateB, setStateB] = useState<ScenarioState | null>(null)
  const [selectedDay, setSelectedDay] = useState('')

  const { grid: gridA, computing: computingA } = useGrid(intervalForecast, stateA, isChat, baseConfig)
  const { grid: gridB, computing: computingB } = useGrid(
    intervalForecast,
    compare ? stateB : null,
    isChat,
    baseConfig,
  )

  const summaryA = useMemo(
    () => (gridA ? summarize(gridA, intervalForecast, stateA.volumeDeltaPct) : null),
    [gridA, intervalForecast, stateA.volumeDeltaPct],
  )
  const summaryB = useMemo(
    () => (gridB && stateB ? summarize(gridB, intervalForecast, stateB.volumeDeltaPct) : null),
    [gridB, stateB, intervalForecast],
  )

  const dates = useMemo(() => (summaryA ? summaryA.days.map((d) => d.date) : []), [summaryA])
  const day = dates.includes(selectedDay) ? selectedDay : dates[0] ?? ''

  const chartRows = useMemo<StaffingRow[]>(() => {
    if (!gridA || !day) return []
    return gridA.intervals
      .filter((iv) => iv.ts.startsWith(day))
      .map((iv) => ({ time: iv.ts.slice(11, 16), scheduled: iv.scheduled, required: iv.required }))
  }, [gridA, day])

  const bDailyByDate = useMemo(() => {
    const m = new Map<string, number>()
    if (summaryB) for (const d of summaryB.days) m.set(d.date, d.scheduledFte)
    return m
  }, [summaryB])

  const computing = computingA || computingB

  const toggleCompare = (on: boolean) => {
    setCompare(on)
    if (on) setStateB((prev) => prev ?? { ...stateA })
  }

  return (
    <div className="staffing-layout">
      <div className="stack">
        <ScenarioPanel
          title={compare ? 'Scenario A' : 'Scenario'}
          state={stateA}
          isChatQueue={isChat}
          onChange={(patch) => setStateA((s) => ({ ...s, ...patch }))}
        />
        <div className="card">
          <div className="check-row" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              id="compare-scenario"
              checked={compare}
              onChange={(e) => toggleCompare(e.target.checked)}
            />
            <label htmlFor="compare-scenario">Compare scenario</label>
          </div>
        </div>
        {compare && stateB && (
          <ScenarioPanel
            title="Scenario B"
            state={stateB}
            isChatQueue={isChat}
            onChange={(patch) => setStateB((s) => (s ? { ...s, ...patch } : s))}
          />
        )}
      </div>

      <div className="stack">
        <div className="row">
          <h2>
            Staffing for the {horizon}-day ensemble forecast: {queue}
          </h2>
          {computing && (
            <span className="note">
              <span className="spinner" /> Recomputing...
            </span>
          )}
        </div>

        {summaryA && (
          <div className="cards-row">
            <div className="card">
              <div className="metric-label">Peak scheduled agents</div>
              <div className="metric-value">{fmtNum(summaryA.peakScheduled, 1)}</div>
              <div className="metric-sub">busiest interval, after shrinkage</div>
              {summaryB && (
                <div className="metric-delta">
                  B minus A: {fmtSigned(summaryB.peakScheduled - summaryA.peakScheduled, 1)}
                </div>
              )}
            </div>
            <div className="card">
              <div className="metric-label">Scheduled FTE-hours, horizon total</div>
              <div className="metric-value">{fmtInt(summaryA.totalScheduledFte)}</div>
              {summaryB && (
                <div className="metric-delta">
                  B minus A: {fmtSigned(summaryB.totalScheduledFte - summaryA.totalScheduledFte, 0)}
                </div>
              )}
            </div>
            <div className="card">
              <div className="metric-label">Weighted avg occupancy</div>
              <div className="metric-value">{fmtPct(summaryA.weightedOcc)}</div>
              <div className="metric-sub">volume-weighted across intervals</div>
              {summaryB && (
                <div className="metric-delta">
                  B minus A: {fmtSigned((summaryB.weightedOcc - summaryA.weightedOcc) * 100, 1)} pts
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-title">
            <h2>Interval staffing{compare ? ': scenario A' : ''}</h2>
            <span className="card-subtitle">
              Bars: scheduled agents. Line: bodies required on the phones.
            </span>
            <span style={{ flex: 1 }} />
            <select value={day} onChange={(e) => setSelectedDay(e.target.value)}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {fmtDateWeekday(d)}
                </option>
              ))}
            </select>
          </div>
          {chartRows.length > 0 ? (
            <StaffingIntervalChart rows={chartRows} theme={theme} />
          ) : (
            <div className="note">Computing staffing grid...</div>
          )}
        </div>

        {summaryA && (
          <div className="card">
            <div className="card-title">
              <h2>Daily summary{compare ? ': scenario A' : ''}</h2>
              <span className="card-subtitle">
                SL, ASA, and abandonment are volume-weighted projections at the staffed level
              </span>
            </div>
            <div className="scroll" style={{ maxHeight: 420 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Contacts</th>
                    <th className="num">Required FTE-h</th>
                    <th className="num">Scheduled FTE-h</th>
                    <th className="num">Peak agents</th>
                    <th className="num">SL</th>
                    <th className="num">ASA</th>
                    <th className="num">Abandon</th>
                    {summaryB && <th className="num">Sched. FTE-h (B)</th>}
                    {summaryB && <th className="num">B minus A</th>}
                  </tr>
                </thead>
                <tbody>
                  {summaryA.days.map((d) => (
                    <tr key={d.date}>
                      <td>{fmtDateWeekday(d.date)}</td>
                      <td className="num">{fmtInt(d.contacts)}</td>
                      <td className="num">{fmtNum(d.requiredFte, 1)}</td>
                      <td className="num">{fmtNum(d.scheduledFte, 1)}</td>
                      <td className="num">{fmtInt(d.peakRequired)}</td>
                      <td className="num">{fmtPct(d.sl)}</td>
                      <td className="num">{fmtSec(d.asa)}</td>
                      <td className="num">{fmtPct(d.abandon)}</td>
                      {summaryB && (
                        <td className="num">{fmtNum(bDailyByDate.get(d.date) ?? 0, 1)}</td>
                      )}
                      {summaryB && (
                        <td className="num">
                          {fmtSigned((bDailyByDate.get(d.date) ?? 0) - d.scheduledFte, 1)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
