import { useMemo, useRef, useState } from 'react'
import type { IntervalRecord } from './engine/types'
import type { CsvError } from './engine/csv'
import { parseCsv } from './engine/csv'
import { errorMessage } from './ui/errors'
import { generateSampleData } from './engine/sampleData'
import { runForecast } from './engine/forecastPipeline'
import type { ForecastResult } from './engine/forecastPipeline'
import { Tabs } from './ui/Tabs'
import type { TabId } from './ui/Tabs'
import { DataTab } from './ui/DataTab'
import { ForecastTab } from './ui/ForecastTab'
import type { Horizon } from './ui/ForecastTab'
import { AccuracyTab } from './ui/AccuracyTab'
import { StaffingTab } from './ui/StaffingTab'
import { EmptyState } from './ui/EmptyState'
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

  // Memoized per (data, queue, horizon) so tab switches never recompute.
  const forecastCache = useRef(new Map<string, ForecastResult>())
  const forecast = useMemo(() => {
    if (!records || !queue) return null
    const key = `${queue}|${horizon}`
    let f = forecastCache.current.get(key)
    if (!f) {
      f = runForecast(records, queue, { horizonDays: horizon })
      forecastCache.current.set(key, f)
    }
    return f
  }, [records, queue, horizon])

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

  return (
    <>
      <header className="app-header">
        <div className="app-title">WFM Forecast &amp; Staffing Workbench</div>
        <Tabs active={tab} onChange={setTab} />
        <div className="header-spacer" />
        {hasData && (
          <div className="queue-picker">
            <span>Queue</span>
            <select value={queue} onChange={(e) => setQueueChoice(e.target.value)}>
              {queues.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      <main className="container">
        <div hidden={tab !== 'data'}>
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

        <div hidden={tab !== 'forecast'}>
          {hasData && forecast ? (
            <ForecastTab
              records={records}
              queue={queue}
              forecast={forecast}
              horizon={horizon}
              theme={theme}
              onHorizonChange={setHorizon}
            />
          ) : (
            <EmptyState
              title="No data loaded"
              text="Load the sample dataset or upload a CSV to build a forecast."
              onGoData={() => setTab('data')}
            />
          )}
        </div>

        <div hidden={tab !== 'accuracy'}>
          {hasData ? (
            <AccuracyTab records={records} queue={queue} theme={theme} />
          ) : (
            <EmptyState
              title="No data loaded"
              text="Load the sample dataset or upload a CSV to backtest forecast accuracy."
              onGoData={() => setTab('data')}
            />
          )}
        </div>

        <div hidden={tab !== 'staffing'}>
          {hasData && forecast ? (
            <StaffingTab forecast={forecast} queue={queue} horizon={horizon} theme={theme} />
          ) : (
            <EmptyState
              title="No data loaded"
              text="Load the sample dataset or upload a CSV to compute staffing requirements."
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
