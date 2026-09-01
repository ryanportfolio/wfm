import { useEffect, useMemo, useRef, useState } from 'react'
import type { IntervalRecord } from './engine/types'
import type { CsvError } from './engine/csv'
import { parseCsv } from './engine/csv'
import { errorMessage } from './ui/errors'
import { generateSampleData } from './engine/sampleData'
import { forecastInWorker } from './ui/workerClient'
import type { ForecastResult } from './engine/forecastPipeline'
import { Tabs } from './ui/Tabs'
import type { TabId } from './ui/Tabs'
import { DataTab } from './ui/DataTab'
import { ForecastTab } from './ui/ForecastTab'
import type { Horizon } from './ui/ForecastTab'
import { AccuracyTab } from './ui/AccuracyTab'
import { StaffingTab } from './ui/StaffingTab'
import { EmptyState } from './ui/EmptyState'
import { ThemeToggle } from './ui/ThemeToggle'
import { useChartTheme } from './ui/theme'

export default function App() {
  const theme = useChartTheme()
  const [tab, setTab] = useState<TabId>('data')
  const [records, setRecords] = useState<IntervalRecord[] | null>(null)
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([])
  const [sourceLabel, setSourceLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const [queueChoice, setQueueChoice] = useState('')
  const [horizon, setHorizon] = useState<Horizon>(14)

  const queues = useMemo(() => {
    if (!records) return []
    const seen = new Set<string>()
    for (const r of records) seen.add(r.queue)
    return [...seen].sort()
  }, [records])

  // The chosen queue survives data reloads when it still exists.
  const queue = queues.includes(queueChoice) ? queueChoice : queues[0] ?? ''

  // Cached per (queue, horizon) so tab switches never recompute; the cache is
  // cleared when a new dataset loads. Cache misses compute in the worker, so
  // the forecast arrives async and the UI shows a computing card meanwhile.
  const forecastCache = useRef(new Map<string, ForecastResult>())
  const [forecast, setForecast] = useState<ForecastResult | null>(null)
  const [forecastError, setForecastError] = useState<string | null>(null)
  useEffect(() => {
    if (!records || !queue) {
      setForecast(null)
      return
    }
    const key = `${queue}|${horizon}`
    const cached = forecastCache.current.get(key)
    if (cached) {
      setForecast(cached)
      return
    }
    setForecast(null)
    let stale = false
    forecastInWorker(records, queue, { horizonDays: horizon })
      .then((f) => {
        forecastCache.current.set(key, f)
        if (!stale) setForecast(f)
      })
      .catch((err) => {
        if (!stale) setForecastError(errorMessage(err))
      })
    return () => {
      stale = true
    }
  }, [records, queue, horizon])

  // Surface a failed forecast the same way the old synchronous throw did:
  // through the app-level error boundary.
  if (forecastError) throw new Error(`Forecast failed: ${forecastError}`)

  const setData = (recs: IntervalRecord[], errors: CsvError[], label: string) => {
    setCsvErrors(errors)
    if (recs.length > 0) {
      forecastCache.current.clear()
      setRecords(recs)
      setSourceLabel(label)
      setLoadError(null)
    } else {
      // Nothing usable came in: keep the current dataset and say so explicitly.
      setLoadError(
        records
          ? `Load of "${label}" failed: no valid rows. Still showing: ${sourceLabel}.`
          : `Load of "${label}" failed: no valid rows. No dataset is loaded.`,
      )
    }
  }

  const loadSample = () => {
    setLoadingSample(true)
    // Yield a frame so the loading state paints before generation blocks.
    setTimeout(() => {
      try {
        setData(generateSampleData(), [], 'Sample dataset (generated)')
      } catch (err) {
        setLoadError(`Sample data failed: ${errorMessage(err)}. Use the button to try again.`)
      } finally {
        setLoadingSample(false)
      }
    }, 30)
  }

  const loadCsv = (file: File) => {
    file
      .text()
      .then((text) => {
        const { records: recs, errors } = parseCsv(text)
        setData(recs, errors, file.name)
      })
      .catch(() => {
        setData([], [{ row: 1, message: 'could not read the file' }], file.name)
      })
  }

  const hasData = records !== null && queue !== ''

  // Shown in forecast-dependent tabs while the worker computes a cache miss.
  const computingCard = (
    <div className="card">
      <p className="note" style={{ margin: 0 }}>
        <span className="spinner" /> Computing the forecast...
      </p>
    </div>
  )

  return (
    <>
      <header className="app-header">
        <h1 className="app-title">WFM Forecast &amp; Staffing Workbench</h1>
        <Tabs active={tab} onChange={setTab} />
        <div className="header-spacer" />
        {hasData && (
          <div className="queue-picker">
            <label htmlFor="queue-select">Queue</label>
            <select
              id="queue-select"
              value={queue}
              onChange={(e) => setQueueChoice(e.target.value)}
            >
              {queues.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
        )}
        <ThemeToggle />
      </header>

      <main className="container">
        <div hidden={tab !== 'data'} role="tabpanel" id="panel-data" aria-labelledby="tab-data">
          <DataTab
            records={records}
            csvErrors={csvErrors}
            loadingSample={loadingSample}
            sourceLabel={sourceLabel}
            loadError={loadError}
            queues={queues}
            queue={queue}
            forecast={forecast}
            theme={theme}
            onLoadSample={loadSample}
            onCsvFile={loadCsv}
          />
        </div>

        <div
          hidden={tab !== 'forecast'}
          role="tabpanel"
          id="panel-forecast"
          aria-labelledby="tab-forecast"
        >
          {hasData && forecast ? (
            <ForecastTab
              records={records}
              queue={queue}
              forecast={forecast}
              horizon={horizon}
              theme={theme}
              onHorizonChange={setHorizon}
            />
          ) : hasData ? (
            computingCard
          ) : (
            <EmptyState
              title="No data to forecast yet"
              text="Once data is loaded, this tab shows a daily forecast chart with a calibrated 80% range, an intraday volume and AHT view, and the blend weights the ensemble fitted per horizon bucket."
              onGoData={() => setTab('data')}
            />
          )}
        </div>

        <div
          hidden={tab !== 'accuracy'}
          role="tabpanel"
          id="panel-accuracy"
          aria-labelledby="tab-accuracy"
        >
          {hasData ? (
            <AccuracyTab records={records} queue={queue} theme={theme} />
          ) : (
            <EmptyState
              title="No data to backtest yet"
              text="Once data is loaded, this tab scores every forecast method on held-out history: a WAPE, MAPE, and bias scorecard at interval, daily, and weekly grain, plus accuracy by lead time."
              onGoData={() => setTab('data')}
            />
          )}
        </div>

        <div
          hidden={tab !== 'staffing'}
          role="tabpanel"
          id="panel-staffing"
          aria-labelledby="tab-staffing"
        >
          {hasData && forecast ? (
            <StaffingTab forecast={forecast} queue={queue} horizon={horizon} theme={theme} />
          ) : hasData ? (
            computingCard
          ) : (
            <EmptyState
              title="No data to staff against yet"
              text="Once data is loaded, this tab turns the forecast into agents needed per 30-minute interval, with a scenario panel for service level, shrinkage, patience, and chat concurrency."
              onGoData={() => setTab('data')}
            />
          )}
        </div>
      </main>

      <footer className="footer">
        Built by Ryan Allen. Methods: seasonal moving average, Holt-Winters, dynamic harmonic
        regression, inverse-WAPE ensemble; Erlang A/C staffing.{' '}
        <a href="https://github.com/ryanportfolio/wfm/blob/main/docs/research.md">Research notes</a>
      </footer>
    </>
  )
}
