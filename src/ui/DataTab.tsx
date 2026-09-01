import { useMemo, useRef } from 'react'
import type { IntervalRecord } from '../engine/types'
import type { CsvError } from '../engine/csv'
import { CSV_HEADER, csvTemplate } from '../engine/csv'
import type { ForecastResult } from '../engine/forecastPipeline'
import { toDailySeries } from '../engine/series'
import type { ChartTheme } from './theme'
import { DailyHistoryChart } from './charts/DailyHistoryChart'
import { downloadTextFile } from './download'
import { fmtDateLong, fmtInt, fmtNum } from './format'
import { Term } from './Term'

interface DataTabProps {
  records: IntervalRecord[] | null
  csvErrors: CsvError[]
  loadingSample: boolean
  sourceLabel: string
  loadError: string | null
  queues: string[]
  queue: string
  forecast: ForecastResult | null
  theme: ChartTheme
  onLoadSample: () => void
  onCsvFile: (file: File) => void
}

interface FlaggedRow {
  date: string
  scope: string
  original: number
  replacement: number
}

export function DataTab({
  records,
  csvErrors,
  loadingSample,
  sourceLabel,
  loadError,
  queues,
  queue,
  forecast,
  theme,
  onLoadSample,
  onCsvFile,
}: DataTabProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  const downloadTemplate = () => {
    downloadTextFile('wfm-template.csv', csvTemplate())
  }

  // Header plus the first three example rows, shown as a copyable snippet.
  const exampleSnippet = csvTemplate().split('\n').slice(0, 4).join('\n')

  const daily = useMemo(
    () => (records && queue ? toDailySeries(records, queue).points : []),
    [records, queue],
  )

  const summary = useMemo(() => {
    if (!records || daily.length === 0) return null
    let total = 0
    let ahtWeighted = 0
    for (const p of daily) {
      total += p.total
      ahtWeighted += p.total * p.aht
    }
    return {
      from: daily[0].date,
      to: daily[daily.length - 1].date,
      total,
      avgAht: total > 0 ? ahtWeighted / total : 0,
    }
  }, [records, daily])

  const flaggedRows = useMemo<FlaggedRow[]>(() => {
    if (!forecast) return []
    const rows: FlaggedRow[] = [
      ...forecast.cleanReport.flaggedIntervals.map((f) => ({
        date: f.date,
        scope: `Interval ${f.time.slice(0, 5)}`,
        original: f.original,
        replacement: f.replacement,
      })),
      ...forecast.cleanReport.flaggedDays.map((f) => ({
        date: f.date,
        scope: 'Daily total',
        original: f.original,
        replacement: f.replacement,
      })),
    ]
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return rows
  }, [forecast])

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <h2>Load interval history</h2>
          <span className="card-subtitle">
            One row per half hour: contacts that arrived and average handle time, per queue. CSV
            header: {CSV_HEADER}
          </span>
        </div>
        <div className="row" data-tour="load-data">
          <button
            type="button"
            className="btn btn-primary"
            disabled={loadingSample}
            onClick={onLoadSample}
          >
            {loadingSample ? (
              <>
                <span className="spinner" /> Generating sample data...
              </>
            ) : (
              'Load sample data'
            )}
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Upload CSV
          </button>
          <button type="button" className="btn" onClick={downloadTemplate}>
            Download CSV template
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onCsvFile(file)
              e.target.value = ''
            }}
          />
          {sourceLabel ? <span className="note">Loaded: {sourceLabel}</span> : null}
        </div>
        {loadError && (
          <p className="note error-text" style={{ marginBottom: 0 }}>
            {loadError}
          </p>
        )}
        <p className="note">
          The sample dataset is a generated 2-year, 3-queue public-sector contact center:
          Monday peaks, post-holiday spikes, month-start benefit bumps, twin intraday peaks,
          and a few injected outage outliers for the cleaning step to catch.
        </p>
        <p className="note" style={{ marginBottom: 4 }}>
          Your CSV needs one row per 30-minute interval, like this (copy it as a starting point):
        </p>
        <pre
          className="note"
          style={{
            margin: 0,
            padding: '8px 10px',
            fontFamily: 'ui-monospace, Consolas, monospace',
            overflowX: 'auto',
            userSelect: 'all',
          }}
        >
          {exampleSnippet}
        </pre>
      </div>

      {csvErrors.length > 0 && (
        <div className="card">
          <div className="card-title">
            <h2 className="error-text">CSV row errors ({fmtInt(csvErrors.length)})</h2>
            <span className="card-subtitle">Rows listed below were skipped.</span>
          </div>
          <div className="scroll">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Row</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {csvErrors.slice(0, 500).map((e, i) => (
                  <tr key={i}>
                    <td className="num">{e.row}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {csvErrors.length > 500 && (
            <p className="note" style={{ marginBottom: 0 }}>
              Showing first 500 of {fmtInt(csvErrors.length)} errors.
            </p>
          )}
        </div>
      )}

      {records && summary && (
        <>
          <div className="cards-row">
            <div className="card">
              <div className="metric-label">Date range</div>
              <div className="metric-value" style={{ fontSize: 16 }}>
                {fmtDateLong(summary.from)} to {fmtDateLong(summary.to)}
              </div>
              <div className="metric-sub">{fmtInt(daily.length)} days</div>
            </div>
            <div className="card">
              <div className="metric-label">Total contacts ({queue})</div>
              <div className="metric-value">{fmtInt(summary.total)}</div>
            </div>
            <div className="card">
              <div className="metric-label">
                Avg <Term term="aht">AHT</Term> ({queue})
              </div>
              <div className="metric-value">{fmtNum(summary.avgAht, 0)} s</div>
              <div className="metric-sub">volume-weighted</div>
            </div>
            <div className="card">
              <div className="metric-label">Records</div>
              <div className="metric-value">{fmtInt(records.length)}</div>
              <div className="metric-sub">all queues</div>
            </div>
            <div className="card">
              <div className="metric-label">Queues</div>
              <div className="metric-value">{queues.length}</div>
              <div className="metric-sub">{queues.join(', ')}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              <h2>
                Daily <Term term="offered">contacts offered</Term>: {queue}
              </h2>
              <span className="card-subtitle">Full history</span>
            </div>
            <DailyHistoryChart points={daily} theme={theme} />
          </div>

          {forecast && (
            <div className="card" data-tour="cleaning">
              <div className="card-title">
                <h2>Cleaning report</h2>
                <span className="card-subtitle">
                  Odd spikes and dips get smoothed before forecasting: a value is flagged when it
                  sits far outside what is normal for that weekday and time of day (a{' '}
                  <Term term="mad">MAD</Term> test) and is replaced with the typical value for
                  that slot.
                </span>
              </div>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="badge badge-ember">
                  {fmtInt(forecast.cleanReport.flaggedIntervals.length)} interval outliers
                </span>
                <span className="badge badge-blossom">
                  {fmtInt(forecast.cleanReport.flaggedDays.length)} daily outliers
                </span>
                <span className="badge badge-forest">
                  {fmtInt(forecast.cleanReport.closedHolidays.length)} closed holidays
                </span>
                <span className="badge">
                  {forecast.cleanReport.holidayClosed
                    ? 'Queue closes on holidays: future holidays forecast as zero'
                    : 'Queue open on holidays'}
                </span>
              </div>
              {flaggedRows.length > 0 ? (
                <div className="scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Scope</th>
                        <th className="num">Original</th>
                        <th className="num">Replacement</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flaggedRows.map((r, i) => (
                        <tr key={i}>
                          <td>{fmtDateLong(r.date)}</td>
                          <td>{r.scope}</td>
                          <td className="num">{fmtInt(r.original)}</td>
                          <td className="num">{fmtNum(r.replacement, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="note">No outliers flagged for this queue.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
