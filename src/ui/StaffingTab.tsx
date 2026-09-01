import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForecastPoint } from '../engine/types'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { StaffingConfig, StaffingGridResult } from '../engine/staffing'
import type { StaffingSession } from './workerClient'
import { createStaffingSession, isSuperseded } from './workerClient'
import type { ChartTheme } from './theme'
import { ScenarioPanel, DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'
import type { ScenarioState } from './controls/ScenarioPanel'
import { encodeStaffingHash, isDefaultScenario, staffingUrlFromHash } from './scenarioUrl'
import { staffingDailyCsv, staffingIntervalCsv } from '../engine/exportCsv'
import { downloadTextFile, fileSlug } from './download'
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
  /** Volume-weighted SL across the whole horizon. */
  weightedSl: number
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
    /** An open interval where nothing is ever answered: day ASA shows n/a. */
    asaInf: boolean
  }
  const byDate = new Map<string, Acc>()
  let peakScheduled = 0
  let occW = 0
  let slWAll = 0
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
        asaInf: false,
      }
      byDate.set(date, d)
    }
    d.contacts += offered
    if (iv.required > d.peakRequired) d.peakRequired = iv.required
    d.slW += iv.serviceLevel * offered
    d.asaW += (Number.isFinite(iv.asa) ? iv.asa : 0) * offered
    if (!Number.isFinite(iv.asa) && offered > 0) d.asaInf = true
    d.abW += iv.abandonRate * offered
    d.w += offered
    if (iv.scheduled > peakScheduled) peakScheduled = iv.scheduled
    occW += iv.occupancy * offered
    slWAll += iv.serviceLevel * offered
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
    asa: d.asaInf ? Infinity : d.w > 0 ? d.asaW / d.w : 0,
    abandon: d.w > 0 ? d.abW / d.w : 0,
  }))
  days.sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    days,
    peakScheduled,
    totalScheduledFte,
    weightedOcc: wSum > 0 ? occW / wSum : 0,
    weightedSl: wSum > 0 ? slWAll / wSum : 1,
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
  // One worker session per hook instance: a new request drops this session's
  // previous in-flight one, so scenario A and B never cancel each other.
  const sessionRef = useRef<StaffingSession | null>(null)
  if (sessionRef.current === null) sessionRef.current = createStaffingSession()

  useEffect(() => {
    // The sync setState calls below reset request state when the scenario
    // changes; the grid itself arrives from the worker's async response.
    if (!debounced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the grid when the scenario is removed
      setGrid(null)
      setError(null)
      return
    }
    setComputing(true)
    // The Erlang grid solves in the compute worker; slider interaction stays
    // responsive. A newer request supersedes this one, and the stale flag
    // drops any response that lands after this effect was cleaned up.
    let stale = false
    sessionRef
      .current!(intervalForecast, toEngineScenario(debounced, isChat), baseConfig)
      .then((g) => {
        if (stale) return
        setGrid(g)
        setError(null)
        setComputing(false)
      })
      .catch((err) => {
        if (stale || isSuperseded(err)) return
        setGrid(null)
        setError(errorMessage(err))
        setComputing(false)
      })
    return () => {
      stale = true
    }
  }, [debounced, intervalForecast, isChat, baseConfig, attempt])

  return { grid, computing, error, retry: () => setAttempt((a) => a + 1) }
}

export function StaffingTab({ forecast, queue, horizon, theme }: StaffingTabProps) {
  const isChat = queue.toLowerCase().includes('chat')
  const intervalForecast = forecast.intervalForecast

  // Only intervalSec and queue from this base ever reach the engine:
  // toEngineScenario always supplies mode, slPct, slSeconds, patienceSec,
  // shrinkage, occupancyCap, and chatConcurrency, so the service fields here
  // are placeholders satisfying StaffingConfig, sourced from DEFAULT_SCENARIO
  // so they cannot drift from the real defaults.
  const baseConfig = useMemo<StaffingConfig>(
    () => ({
      mode: DEFAULT_SCENARIO.mode,
      slPct: DEFAULT_SCENARIO.slPct / 100,
      slSeconds: DEFAULT_SCENARIO.slSeconds,
      patienceSec: DEFAULT_SCENARIO.patienceSec,
      shrinkage: DEFAULT_SCENARIO.shrinkagePct / 100,
      intervalSec: deriveIntervalSec(intervalForecast),
      queue,
    }),
    [intervalForecast, queue],
  )

  // A shared link (#s=...&r=...) seeds scenarios and cost rate; otherwise defaults.
  const [initialUrl] = useState(() => staffingUrlFromHash(window.location.hash))
  const [stateA, setStateA] = useState<ScenarioState>(initialUrl.scenarios?.a ?? DEFAULT_SCENARIO)
  const [compare, setCompare] = useState(initialUrl.scenarios?.b != null)
  const [stateB, setStateB] = useState<ScenarioState | null>(initialUrl.scenarios?.b ?? null)
  const [selectedDay, setSelectedDay] = useState('')
  const [copied, setCopied] = useState(false)

  // Cost per scheduled hour. Raw text so partial input ("0.", "12.") survives
  // typing; the parsed rate is null (feature off) until the text is a positive
  // number.
  const [costText, setCostText] = useState(() =>
    initialUrl.costPerHour !== null ? String(initialUrl.costPerHour) : '',
  )
  const costRate = useMemo(() => {
    if (costText.trim() === '') return null
    const n = Number(costText)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [costText])

  // Keep the URL hash in sync (replaceState, so no history spam). Empty hash
  // means everything is at defaults; drop it entirely then.
  const urlHash = useMemo(
    () => encodeStaffingHash(stateA, compare ? stateB : null, costRate),
    [stateA, stateB, compare, costRate],
  )
  const debouncedHash = useDebounced(urlHash, 200)
  useEffect(() => {
    const base = window.location.pathname + window.location.search
    window.history.replaceState(null, '', debouncedHash ? `${base}#${debouncedHash}` : base)
  }, [debouncedHash])

  const clipboardOk = typeof navigator !== 'undefined' && !!navigator.clipboard
  const copyLink = () => {
    const { origin, pathname, search } = window.location
    const url = `${origin}${pathname}${search}${urlHash ? `#${urlHash}` : ''}`
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }

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

  const fixedA = stateA.staffMode === 'fixed'
  const anyFixed = fixedA || (compare && stateB?.staffMode === 'fixed')
  const slTargetA = stateA.slPct / 100

  // First switch to "what I have" with heads still unset (0): seed from the
  // peak scheduled heads the target solve produced, the number an analyst
  // would start bargaining from.
  const seedHeads = (
    state: ScenarioState,
    patch: Partial<ScenarioState>,
    summary: GridSummary | null,
  ): ScenarioState => {
    const next = { ...state, ...patch }
    if (patch.staffMode === 'fixed' && next.fixedHeads === 0 && summary) {
      next.fixedHeads = Math.min(200, Math.max(1, Math.ceil(summary.peakScheduled)))
    }
    return next
  }

  const dates = useMemo(() => (summaryA ? summaryA.days.map((d) => d.date) : []), [summaryA])
  const day = dates.includes(selectedDay) ? selectedDay : dates[0] ?? ''

  const chartRows = useMemo<StaffingRow[]>(() => {
    if (!gridA || !day) return []
    return gridA.intervals
      .filter((iv) => iv.ts.startsWith(day))
      .map((iv) => ({
        time: iv.ts.slice(11, 16),
        scheduled: iv.scheduled,
        required: iv.required,
        understaffed: fixedA && iv.serviceLevel < slTargetA,
        unstable: iv.unstable === true,
      }))
  }, [gridA, day, fixedA, slTargetA])

  const dayUnderstaffed = chartRows.filter((r) => r.understaffed).length
  const dayUnstable = chartRows.filter((r) => r.unstable).length

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

  // The grid holds staffing outputs only; rebuild the scenario-scaled
  // offered/AHT inputs so the interval CSV shows them side by side.
  const downloadIntervals = (grid: StaffingGridResult, state: ScenarioState, suffix: string) => {
    const vs = 1 + state.volumeDeltaPct / 100
    const as = 1 + state.ahtDeltaPct / 100
    const scaled = intervalForecast.map((p) => ({ offered: p.offered * vs, aht: p.aht * as }))
    downloadTextFile(
      `staffing-intervals-${fileSlug(queue)}${suffix}.csv`,
      staffingIntervalCsv(grid.intervals, scaled),
    )
  }
  const downloadDaily = (summary: GridSummary, suffix: string) => {
    downloadTextFile(
      `staffing-daily-${fileSlug(queue)}${suffix}.csv`,
      staffingDailyCsv(summary.days, costRate ?? undefined),
    )
  }

  return (
    <div className="staffing-layout">
      <div className="stack">
        <ScenarioPanel
          title={compare ? 'Scenario A' : 'Scenario'}
          dataTour="scenario"
          state={stateA}
          isChatQueue={isChat}
          onChange={(patch) => setStateA((s) => seedHeads(s, patch, summaryA))}
          onReset={() => setStateA({ ...DEFAULT_SCENARIO })}
          isDefault={isDefaultScenario(stateA)}
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
                onChange={(patch) => setStateB((s) => (s ? seedHeads(s, patch, summaryB ?? summaryA) : s))}
                onReset={() => setStateB({ ...DEFAULT_SCENARIO })}
                isDefault={isDefaultScenario(stateB)}
              />
            )}
            <button type="button" className="btn" onClick={() => toggleCompare(false)}>
              Remove scenario B
            </button>
          </>
        )}
        <div className="card">
          <div className="slider-row">
            <div className="slider-head">
              <label htmlFor="cost-rate">Cost per scheduled hour</label>
            </div>
            <input
              id="cost-rate"
              className="num-input"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              placeholder="off"
              value={costText}
              onChange={(e) => setCostText(e.target.value)}
            />
            <div className="slider-hint">
              Scheduled hours times this rate, in whatever currency you use. Simple
              multiplication only: no overtime or benefits math. Leave blank to hide cost.
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!clipboardOk}
          title={
            clipboardOk
              ? 'Copies a link that restores these scenario settings'
              : 'Clipboard is not available in this browser; copy the page address instead'
          }
          onClick={copyLink}
        >
          {copied ? 'Copied' : 'Copy link to this scenario'}
        </button>
      </div>

      <div className="stack">
        <div className="row">
          <h2>
            Staffing plan, next {horizon} days: {queue}
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
          <div className="cards-row" data-tour="staffing-results">
            <div className="card">
              <div className="metric-label">Peak scheduled agents</div>
              <div className="metric-value">{fmtNum(summaryA.peakScheduled, 1)}</div>
              <div className="metric-sub">people to schedule for the busiest half hour, breaks and meetings included</div>
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
              {costRate !== null && (
                <div className="metric-sub">
                  cost {fmtInt(summaryA.totalScheduledFte * costRate)}: scheduled hours x{' '}
                  {fmtNum(costRate, 2)}
                </div>
              )}
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
              {costRate !== null && summaryB && (
                <div
                  className={`metric-delta ${deltaClass(
                    (summaryB.totalScheduledFte - summaryA.totalScheduledFte) * costRate,
                    true,
                    0.5,
                  )}`}
                >
                  cost B minus A:{' '}
                  {fmtSigned((summaryB.totalScheduledFte - summaryA.totalScheduledFte) * costRate, 0)}
                </div>
              )}
            </div>
            {anyFixed && (
              <div className="card">
                <div className="metric-label">
                  Projected <Term term="sl">SL</Term>
                </div>
                <div
                  className={`metric-value ${
                    summaryA.weightedSl >= slTargetA ? 'delta-good' : 'delta-bad'
                  }`}
                >
                  {fmtPct(summaryA.weightedSl)}
                </div>
                <div className="metric-sub">
                  average across the day, busy times counting most, vs the {fmtPct(slTargetA, 0)}{' '}
                  target
                </div>
                {summaryB && (
                  <div
                    className={`metric-delta ${deltaClass(
                      summaryB.weightedSl - summaryA.weightedSl,
                      false,
                      0.0005,
                    )}`}
                  >
                    B minus A: {fmtSigned((summaryB.weightedSl - summaryA.weightedSl) * 100, 1)} pts
                  </div>
                )}
              </div>
            )}
            <div className="card">
              <div className="metric-label">
                Weighted avg <Term term="occupancy">occupancy</Term>
              </div>
              <div className="metric-value">{fmtPct(summaryA.weightedOcc)}</div>
              <div className="metric-sub">share of time spent handling contacts; busy intervals count most</div>
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

        <div className="card" data-tour="staffing-chart">
          <div className="card-title">
            <h2>Interval staffing{compare ? ': scenario A' : ''}</h2>
            <span className="card-subtitle">
              {fixedA
                ? 'Bars: the people you said you have (red where service falls short). Line: people needed on the phones to hit the target.'
                : 'Bars: people to schedule. Line: people needed on the phones (cover for breaks and meetings comes on top).'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="btn"
              disabled={!gridA}
              aria-label="Download interval staffing CSV, scenario A"
              onClick={() => gridA && downloadIntervals(gridA, stateA, compare ? '-a' : '')}
            >
              {compare ? 'Download CSV (A)' : 'Download CSV'}
            </button>
            {compare && (
              <button
                type="button"
                className="btn"
                disabled={!gridB || !stateB}
                aria-label="Download interval staffing CSV, scenario B"
                onClick={() => gridB && stateB && downloadIntervals(gridB, stateB, '-b')}
              >
                Download CSV (B)
              </button>
            )}
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
            <StaffingIntervalChart rows={chartRows} theme={theme} fixedMode={fixedA} />
          ) : (
            <div className="note">
              {errorA ? 'No staffing grid to show; see the error above.' : 'Computing staffing grid...'}
            </div>
          )}
          {fixedA && chartRows.length > 0 && (
            <p className="note" style={{ marginBottom: 0 }}>
              {dayUnderstaffed > 0
                ? `${dayUnderstaffed} of ${chartRows.length} intervals this day miss the ${fmtPct(
                    slTargetA,
                    0,
                  )} target at your staffing.`
                : `All ${chartRows.length} intervals this day meet the ${fmtPct(slTargetA, 0)} target at your staffing.`}
              {dayUnstable > 0 &&
                ` In ${dayUnstable} of them the queue would keep growing all interval because arrivals outpace the people on phones (Erlang C calls this unstable).`}
            </p>
          )}
        </div>

        {summaryA && (
          <div className="card">
            <div className="card-title">
              <h2>Daily summary{compare ? ': scenario A' : ''}</h2>
              <span className="card-subtitle">
                Service level, answer speed, and abandonment are projections at this staffing,
                busy times counting most. Peak on phones counts people actually handling contacts,
                before adding cover for breaks and meetings.
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="btn"
                aria-label="Download daily staffing summary CSV, scenario A"
                onClick={() => downloadDaily(summaryA, compare ? '-a' : '')}
              >
                {compare ? 'Download CSV (A)' : 'Download CSV'}
              </button>
              {compare && (
                <button
                  type="button"
                  className="btn"
                  disabled={!summaryB}
                  aria-label="Download daily staffing summary CSV, scenario B"
                  onClick={() => summaryB && downloadDaily(summaryB, '-b')}
                >
                  Download CSV (B)
                </button>
              )}
            </div>
            <div className="scroll" style={{ maxHeight: 420 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Contacts</th>
                    <th className="num">Required FTE-h</th>
                    <th className="num">Scheduled FTE-h</th>
                    {costRate !== null && <th className="num">Cost</th>}
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
                      {costRate !== null && (
                        <td className="num">{fmtInt(d.scheduledFte * costRate)}</td>
                      )}
                      <td className="num">{fmtInt(d.peakRequired)}</td>
                      <td
                        className={`num${
                          fixedA ? (d.sl >= slTargetA ? ' delta-good' : ' delta-bad') : ''
                        }`}
                      >
                        {fmtPct(d.sl)}
                      </td>
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
            The math takes shortcuts you should know about. Staffing comes from the blended
            (ensemble) forecast. Each half hour is solved as its own queue, so callers still
            waiting at the end of one half hour vanish instead of rolling into the next; a badly
            understaffed stretch looks better here than it would in real life. For chat, 2 chats
            at once is treated as one agent working twice as fast, which ignores the juggling cost
            and assumes handle time was measured at that concurrency. Shrinkage grosses up by
            division: at 30%, schedule 10 hours to get 7 on the queue. In "what I have" mode your
            flat headcount applies to every half hour with volume; people on phones = heads x (1 -
            shrinkage), rounded down, and a half hour is marked unstable when arriving work meets
            or exceeds the people on phones (Erlang C). Cost is scheduled hours times your rate,
            nothing else.
          </p>
        </div>
      </div>
    </div>
  )
}
