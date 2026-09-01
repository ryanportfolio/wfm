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
import { errorMessage } from './errors'
import { Term } from './Term'

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

/**
 * CSS class for a B-minus-A delta. `lowerIsBetter` encodes the metric's sign
 * semantics: fewer FTE-hours or fewer peak agents cost less, so a negative
 * delta is good; a delta that rounds to zero at `eps` display precision stays
 * neutral.
 */
function deltaClass(delta: number, lowerIsBetter: boolean, eps: number): string {
  if (Math.abs(delta) < eps) return 'delta-neutral'
  const good = lowerIsBetter ? delta < 0 : delta > 0
  return good ? 'delta-good' : 'delta-bad'
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
): { grid: StaffingGridResult | null; computing: boolean; error: string | null; retry: () => void } {
  const debounced = useDebounced(state, 150)
  const [grid, setGrid] = useState<StaffingGridResult | null>(null)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!debounced) {
      setGrid(null)
      setError(null)
      return
    }
    setComputing(true)
    // Yield so slider interaction stays responsive while Erlang math runs.
    const id = setTimeout(() => {
      try {
        setGrid(applyScenario(intervalForecast, toEngineScenario(debounced, isChat), baseConfig))
        setError(null)
      } catch (err) {
        setGrid(null)
        setError(errorMessage(err))
      } finally {
        setComputing(false)
      }
    }, 0)
    return () => clearTimeout(id)
  }, [debounced, intervalForecast, isChat, baseConfig, attempt])

  return { grid, computing, error, retry: () => setAttempt((a) => a + 1) }
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

  const {
    grid: gridA,
    computing: computingA,
    error: errorA,
    retry: retryA,
  } = useGrid(intervalForecast, stateA, isChat, baseConfig)
  const {
    grid: gridB,
    computing: computingB,
    error: errorB,
    retry: retryB,
  } = useGrid(intervalForecast, compare ? stateB : null, isChat, baseConfig)

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
        {!compare ? (
          <button type="button" className="btn" onClick={() => toggleCompare(true)}>
            Add comparison scenario
          </button>
        ) : (
          <>
            {stateB && (
              <ScenarioPanel
                title="Scenario B"
                state={stateB}
                isChatQueue={isChat}
                onChange={(patch) => setStateB((s) => (s ? { ...s, ...patch } : s))}
              />
            )}
            <button type="button" className="btn" onClick={() => toggleCompare(false)}>
              Remove scenario B
            </button>
          </>
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

        {(errorA || errorB) && (
          <div className="card">
            <div className="card-title">
              <h2 className="error-text">Staffing computation failed</h2>
            </div>
            {errorA && <p className="note">Scenario A: {errorA}</p>}
            {errorB && <p className="note">Scenario B: {errorB}</p>}
            <p className="note">
              Adjust the scenario settings or retry with the same values.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (errorA) retryA()
                  if (errorB) retryB()
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {summaryA && (
          <div className="cards-row">
            <div className="card">
              <div className="metric-label">Peak scheduled agents</div>
              <div className="metric-value">{fmtNum(summaryA.peakScheduled, 1)}</div>
              <div className="metric-sub">scheduled heads in the busiest interval, after shrinkage</div>
              {summaryB && (
                <div
                  className={`metric-delta ${deltaClass(
                    summaryB.peakScheduled - summaryA.peakScheduled,
                    true,
                    0.05,
                  )}`}
                >
                  B minus A: {fmtSigned(summaryB.peakScheduled - summaryA.peakScheduled, 1)}
                </div>
              )}
            </div>
            <div className="card">
              <div className="metric-label">
                Scheduled <Term term="fte">FTE-hours</Term>, horizon total
              </div>
              <div className="metric-value">{fmtInt(summaryA.totalScheduledFte)}</div>
              {summaryB && (
                <div
                  className={`metric-delta ${deltaClass(
                    summaryB.totalScheduledFte - summaryA.totalScheduledFte,
                    true,
                    0.5,
                  )}`}
                >
                  B minus A: {fmtSigned(summaryB.totalScheduledFte - summaryA.totalScheduledFte, 0)}
                </div>
              )}
            </div>
            <div className="card">
              <div className="metric-label">
                Weighted avg <Term term="occupancy">occupancy</Term>
              </div>
              <div className="metric-value">{fmtPct(summaryA.weightedOcc)}</div>
              <div className="metric-sub">volume-weighted across intervals</div>
              {summaryB && (
                // Occupancy has no clean better direction (higher is cheaper
                // but harder on agents), so the delta stays neutral.
                <div className="metric-delta delta-neutral">
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
            <select
              aria-label="Day shown in the interval staffing chart"
              value={day}
              onChange={(e) => setSelectedDay(e.target.value)}
            >
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
            <div className="note">
              {errorA ? 'No staffing grid to show; see the error above.' : 'Computing staffing grid...'}
            </div>
          )}
        </div>

        {summaryA && (
          <div className="card">
            <div className="card-title">
              <h2>Daily summary{compare ? ': scenario A' : ''}</h2>
              <span className="card-subtitle">
                SL, ASA, and abandonment are volume-weighted projections at the staffed level.
                Peak on phones is bodies handling contacts, before shrinkage.
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
                    <th className="num">Peak on phones</th>
                    <th className="num">
                      <Term term="sl">SL</Term>
                    </th>
                    <th className="num">
                      <Term term="asa">ASA</Term>
                    </th>
                    <th className="num">
                      <Term term="abandonment">Abandon</Term>
                    </th>
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
                        <td
                          className={`num ${deltaClass(
                            (bDailyByDate.get(d.date) ?? 0) - d.scheduledFte,
                            true,
                            0.05,
                          )}`}
                        >
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

        <div className="card">
          <div className="card-title">
            <h2>Model assumptions</h2>
          </div>
          <p className="note" style={{ marginBottom: 0 }}>
            Each interval is solved as its own steady-state queue, so callers still waiting at the
            end of one interval do not carry over into the next; a badly understaffed stretch looks
            better here than it would in reality. For chat queues, concurrency divides AHT, treating
            one agent on 2 chats as one agent twice as fast; that ignores the extra variability of
            juggling chats and assumes AHT was measured at that concurrency. Shrinkage grosses up by
            division: at 30%, you schedule 10 hours to get 7 on the queue.
          </p>
        </div>
      </div>
    </div>
  )
}
