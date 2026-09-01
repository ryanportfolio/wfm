import { useMemo, useState } from 'react'
import type { IntervalRecord } from '../engine/types'
import type { ForecastResult } from '../engine/forecastPipeline'
import { toDailySeries } from '../engine/series'
import type { ChartTheme, UiMethod } from './theme'
import { METHOD_COLORS, METHOD_LABELS, METHOD_SHORT } from './theme'
import { ForecastChart } from './charts/ForecastChart'
import type { ForecastChartRow } from './charts/ForecastChart'
import { IntradayForecastChart } from './charts/IntradayForecastChart'
import type { IntradayRow } from './charts/IntradayForecastChart'
import { fmtDateWeekday, fmtPct } from './format'

export type Horizon = 7 | 14 | 28

const HORIZONS: Horizon[] = [7, 14, 28]
const HISTORY_DAYS = 56

interface ForecastTabProps {
  records: IntervalRecord[]
  queue: string
  forecast: ForecastResult
  horizon: Horizon
  theme: ChartTheme
  onHorizonChange: (h: Horizon) => void
}

const COMPONENT_METHODS: UiMethod[] = ['sma', 'hw', 'dhr']

export function ForecastTab({ records, queue, forecast, horizon, theme, onHorizonChange }: ForecastTabProps) {
  const [visible, setVisible] = useState<Record<UiMethod, boolean>>({
    sma: true,
    hw: true,
    dhr: true,
    ensemble: true,
  })
  const [intradayDate, setIntradayDate] = useState('')

  const actualPoints = useMemo(
    () => toDailySeries(records, queue).points.slice(-HISTORY_DAYS),
    [records, queue],
  )
  const lastActualDate = actualPoints[actualPoints.length - 1]?.date ?? ''

  const rows = useMemo<ForecastChartRow[]>(() => {
    const out: ForecastChartRow[] = actualPoints.map((p) => ({ date: p.date, actual: p.total }))
    forecast.ensemble.forEach((p, j) => {
      out.push({
        date: p.date,
        sma: forecast.components.sma[j].total,
        hw: forecast.components.hw[j].total,
        dhr: forecast.components.dhr[j].total,
        ensemble: p.total,
        band: forecast.band ? [p.lo, p.hi] : undefined,
      })
    })
    return out
  }, [actualPoints, forecast])

  const forecastDates = useMemo(() => forecast.ensemble.map((p) => p.date), [forecast])
  const selectedDate = forecastDates.includes(intradayDate) ? intradayDate : forecastDates[0]

  const intradayRows = useMemo<IntradayRow[]>(
    () =>
      forecast.intervalForecast
        .filter((p) => p.ts.startsWith(selectedDate))
        .map((p) => ({ time: p.ts.slice(11, 16), offered: p.offered, aht: p.aht })),
    [forecast, selectedDate],
  )

  const buckets = forecast.weights.buckets.filter((b) => b.fromDay <= horizon)

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <h2>Daily forecast: {queue}</h2>
          <span className="card-subtitle">Last 8 weeks of actuals plus the forecast horizon</span>
          <span style={{ flex: 1 }} />
          <div className="row">
            <span className="note">Horizon</span>
            <div className="seg">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={horizon === h ? 'active' : ''}
                  onClick={() => onHorizonChange(h)}
                >
                  {h} days
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="legend-row">
          <label style={{ cursor: 'default' }}>
            <span className="swatch" style={{ background: theme.actual }} />
            Actual
          </label>
          {(['sma', 'hw', 'dhr', 'ensemble'] as UiMethod[]).map((m) => (
            <label key={m}>
              <input
                type="checkbox"
                checked={visible[m]}
                onChange={(e) => setVisible((v) => ({ ...v, [m]: e.target.checked }))}
              />
              <span className="swatch" style={{ background: METHOD_COLORS[m] }} />
              {METHOD_LABELS[m]}
            </label>
          ))}
          {forecast.band && (
            <label style={{ cursor: 'default' }}>
              <span
                className="swatch"
                style={{ background: METHOD_COLORS.ensemble, opacity: 0.3 }}
              />
              80% range
            </label>
          )}
        </div>
        <ForecastChart rows={rows} lastActualDate={lastActualDate} visible={visible} theme={theme} />
        <p className="note" style={{ marginBottom: 0 }}>
          {forecast.band
            ? 'Shaded range around the ensemble line: 80% of its rolling-origin evaluation errors fell inside this band, pooled per horizon bucket. It shows and hides with the Ensemble checkbox.'
            : 'No shaded range: history is too short to run the evaluation folds that calibrate it.'}
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">
            <h2>Intraday forecast</h2>
            <span className="card-subtitle">Ensemble offered per interval, AHT on the right axis</span>
            <span style={{ flex: 1 }} />
            <select value={selectedDate} onChange={(e) => setIntradayDate(e.target.value)}>
              {forecastDates.map((d) => (
                <option key={d} value={d}>
                  {fmtDateWeekday(d)}
                </option>
              ))}
            </select>
          </div>
          <IntradayForecastChart rows={intradayRows} theme={theme} />
        </div>

        <div className="card">
          <div className="card-title">
            <h2>What the ensemble learned</h2>
            <span className="card-subtitle">Blend weight per component, fitted per horizon bucket</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Horizon bucket</th>
                {COMPONENT_METHODS.map((m) => (
                  <th key={m} className="num">
                    {METHOD_SHORT[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.label}>
                  <td>Days {b.fromDay} to {b.toDay}</td>
                  {COMPONENT_METHODS.map((m) => (
                    <td key={m} className="num">
                      {fmtPct(b.weights[m as 'sma' | 'hw' | 'dhr'])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note" style={{ marginBottom: 0 }}>
            {forecast.weights.fallbackEqual
              ? 'Equal weights: history is below the minimum needed to fit weights.'
              : `Weights are proportional to inverse WAPE raised to a tuned power, from ${forecast.weights.innerFolds} non-overlapping rolling-origin evaluation folds inside the training window, scored against raw actuals. The power comes from a small grid, so the data decides how much to concentrate on the strongest component versus hedging across all three.`}
          </p>
        </div>
      </div>
    </div>
  )
}
