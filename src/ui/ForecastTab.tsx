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
import { forecastDailyCsv, forecastIntervalCsv } from '../engine/exportCsv'
import { downloadTextFile, fileSlug } from './download'
import { Term } from './Term'

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
      <div className="card" data-tour="forecast-chart">
        <div className="card-title">
          <h2>Daily forecast: {queue}</h2>
          <span className="card-subtitle">Last 8 weeks actual, then forecast</span>
          <span style={{ flex: 1 }} />
          <div className="row">
            <span className="note">Look ahead</span>
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
            <button
              type="button"
              className="btn"
              aria-label="Download daily forecast CSV"
              onClick={() =>
                downloadTextFile(
                  `forecast-daily-${fileSlug(queue)}-${horizon}d.csv`,
                  forecastDailyCsv(forecast.dailyForecast),
                )
              }
            >
              Download CSV
            </button>
          </div>
        </div>
        <div className="legend-row">
          <span className="legend-item">
            <span className="swatch" style={{ background: theme.actual }} />
            Actual
          </span>
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
            <span className="legend-item">
              <span
                className="swatch"
                style={{ background: METHOD_COLORS.ensemble, opacity: 0.3 }}
              />
              80% range
            </span>
          )}
        </div>
        <ForecastChart rows={rows} lastActualDate={lastActualDate} visible={visible} theme={theme} />
        <p className="note" style={{ marginBottom: 0 }}>
          {forecast.band ? (
            <>
              Shaded band: where the real number landed 8 times in 10 in{' '}
              <Term term="rollingOrigin">rolling-origin</Term> tests on unseen days; width varies by
              days-ahead range. Those tests also tuned the blend, so the band can run slightly narrow.
              Untick Ensemble to hide it.
            </>
          ) : (
            'No band: too little history for the tests that set its width.'
          )}
        </p>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-title">
            <h2>Intraday forecast</h2>
            <span className="card-subtitle">
              Predicted contacts per half hour; average handle time (AHT) on the right
            </span>
            <span style={{ flex: 1 }} />
            <select
              aria-label="Day shown in the intraday forecast chart"
              value={selectedDate}
              onChange={(e) => setIntradayDate(e.target.value)}
            >
              {forecastDates.map((d) => (
                <option key={d} value={d}>
                  {fmtDateWeekday(d)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              aria-label="Download intraday forecast CSV"
              onClick={() =>
                downloadTextFile(
                  `forecast-intraday-${fileSlug(queue)}-${horizon}d.csv`,
                  forecastIntervalCsv(forecast.intervalForecast),
                )
              }
            >
              Download CSV
            </button>
          </div>
          <IntradayForecastChart rows={intradayRows} theme={theme} />
        </div>

        <div className="card">
          <div className="card-title">
            <h2>What the blend learned</h2>
            <span className="card-subtitle">
              Each method's share, by days ahead
            </span>
          </div>
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>
                  <Term term="horizonBucket">Horizon bucket</Term>
                </th>
                {COMPONENT_METHODS.map((m) => (
                  <th key={m} className="num">
                    {m === 'dhr' ? <Term term="dhr">DHR</Term> : METHOD_SHORT[m]}
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
          </div>
          <p className="note" style={{ marginBottom: 0 }}>
            {forecast.weights.fallbackEqual ? (
              'Equal shares: too little history to test which method deserves more.'
            ) : (
              <>
                Shares go to the methods that missed least in {forecast.weights.innerFolds}{' '}
                practice tests on hidden slices of history, scored against uncleaned actuals. Each
                share is inverse <Term term="wape">WAPE</Term> raised to a power; the data picks
                that power, which decides whether to back the front-runner hard or spread across
                all three.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
