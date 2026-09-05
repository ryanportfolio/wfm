import { useEffect, useMemo, useRef, useState } from 'react'
import type { IntervalRecord } from './engine/types'
import type { CsvError } from './engine/csv'
import { parseCsv } from './engine/csv'
import { errorMessage } from './ui/errors'
import { generateSampleData } from './engine/sampleData'
import { forecastInWorker } from './ui/workerClient'
import type { ForecastResult } from './engine/forecastPipeline'
import { ProjectControls } from './ui/ProjectControls'
import { initialStaffing, MAX_PROJECT_BYTES, parseProject, serializeProject } from './ui/project'
import type { Project } from './ui/project'
import { downloadTextFile, fileSlug } from './ui/download'
import { Tabs } from './ui/Tabs'
import type { TabId } from './ui/Tabs'
import { DataTab } from './ui/DataTab'
import { ForecastTab } from './ui/ForecastTab'
import type { Horizon } from './ui/ForecastTab'
import { AccuracyTab } from './ui/AccuracyTab'
import { CapacityTab } from './ui/CapacityTab'
import { IntradayTab } from './ui/IntradayTab'
import { emptyIntradayState } from './ui/intradayState'
import type { IntradayState } from './ui/intradayState'
import { emptyCapacityState } from './ui/capacityState'
import type { CapacityState } from './ui/capacityState'
import { StaffingTab } from './ui/StaffingTab'
import { EmptyState } from './ui/EmptyState'
import { ThemeToggle } from './ui/ThemeToggle'
import { useChartTheme } from './ui/theme'
import { GuidedTour } from './ui/tour/GuidedTour'
import { TourNudge } from './ui/tour/TourNudge'
import { markTourSeen, readTourSeen, shouldAutoOffer } from './ui/tour/tourStorage'

export default function App() {
  const theme = useChartTheme()
  const [projectName, setProjectName] = useState('Untitled project')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectStatus, setProjectStatus] = useState<string | null>(null)
  const [staffing, setStaffing] = useState(() => initialStaffing(window.location.hash))
  const importSequence = useRef(0)
  const [tab, setTab] = useState<TabId>('data')
  const [records, setRecords] = useState<IntervalRecord[] | null>(null)
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([])
  const [sourceLabel, setSourceLabel] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const [queueChoice, setQueueChoice] = useState('')
  const [capacityByQueue, setCapacityByQueue] = useState<Record<string, CapacityState>>({})
  const [intradayByQueue, setIntradayByQueue] = useState<Record<string, IntradayState>>({})
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [horizon, setHorizon] = useState<Horizon>(14)
  const [tourOpen, setTourOpen] = useState(false)
  // Decided during the first render, so the offer needs no timer and no state
  // write after mount; the 900ms wait before it appears is a CSS delay.
  const [showNudge, setShowNudge] = useState(() => shouldAutoOffer(readTourSeen()))
  const tourBtnRef = useRef<HTMLButtonElement>(null)

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
    // The sync setForecast calls below reset request state when the inputs
    // change; the real value arrives from the worker's async response.
    if (!records || !queue) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale forecast when the dataset goes away
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
        // Only a live request may cache: a stale one may have computed from a
        // dataset that was replaced after this effect ran, and writing it back
        // would poison the fresh cache under the same queue|horizon key.
        if (!stale) {
          forecastCache.current.set(key, f)
          setForecast(f)
        }
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
      setCapacityByQueue({})
      setIntradayByQueue({})
      setDatasetVersion(v => v + 1)
      setForecast(null)
      setRecords(recs)
      setSourceLabel(label)
      setLoadError(null)
      setProjectError(null)
      setProjectStatus(null)
    } else {
      // Nothing usable came in: keep the current dataset and say so explicitly.
      setLoadError(
        records
          ? `"${label}" had no valid rows. Still showing ${sourceLabel}.`
          : `"${label}" had no valid rows. No dataset loaded.`,
      )
    }
  }

  const loadSample = () => {
    const request = ++importSequence.current
    setLoadingSample(true)
    // Yield a frame so the loading state paints before generation blocks.
    setTimeout(() => {
      try {
        if (request !== importSequence.current) return
        setData(generateSampleData(), [], 'Sample dataset (generated)')
      } catch (err) {
        setLoadError(`Sample data failed: ${errorMessage(err)}. Press Load sample data again.`)
      } finally {
        setLoadingSample(false)
      }
    }, 30)
  }

  const loadCsv = (file: File) => {
    const request = ++importSequence.current
    file
      .text()
      .then((text) => {
        if (request !== importSequence.current) return
        const { records: recs, errors, rejected } = parseCsv(text)
        if (rejected) {
          setCsvErrors(errors)
          setLoadError(`"${file.name}" was rejected because it contains duplicate queue/timestamp rows. ${records ? `Still showing ${sourceLabel}.` : 'No dataset loaded.'}`)
          return
        }
        setData(recs, errors, file.name)
      })
      .catch(() => {
        if (request !== importSequence.current) return
        setData([], [{ row: 1, message: 'could not read the file' }], file.name)
      })
  }

  const openProject = async (file: File) => {
    const request = ++importSequence.current
    setProjectError(null)
    setProjectStatus(null)
    try {
      if (file.size > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 64 MB file limit.')
      const text = await file.text()
      if (request !== importSequence.current) return
      const project = parseProject(text)
      // React batches this validated replacement; no partial project reaches a render.
      forecastCache.current.clear()
      setForecast(null)
      setForecastError(null)
      setRecords(project.records)
      setSourceLabel(project.sourceLabel)
      setQueueChoice(project.queue)
      setHorizon(project.horizon)
      setStaffing(project.staffing)
      setCapacityByQueue(project.capacityByQueue)
      setIntradayByQueue(project.intradayByQueue)
      setDatasetVersion(v => v + 1)
      setProjectName(project.name)
      setCsvErrors([])
      setLoadError(null)
      setProjectStatus('Opened project: ' + project.name)
    } catch (err) {
      if (request === importSequence.current) setProjectError(errorMessage(err) + ' Current work was kept.')
    }
  }
  const saveProject = () => {
    if (!records) return
    try {
      const project: Project = { schema: 'wfm-project', version: 2, name: projectName, records, sourceLabel,
        queue, horizon, staffing, capacityByQueue, intradayByQueue }
      downloadTextFile(fileSlug(projectName) + '.json', serializeProject(project), 'application/json')
      setProjectError(null)
      setProjectStatus('Saved project: ' + projectName)
    } catch (err) {
      setProjectStatus(null)
      setProjectError(errorMessage(err))
    }
  }

  const hasData = records !== null && queue !== ''

  const openTour = () => {
    markTourSeen()
    setShowNudge(false)
    setTourOpen(true)
  }

  const dismissNudge = () => {
    markTourSeen()
    setShowNudge(false)
  }

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
        <div className="header-spacer" />
        {hasData && (
          <div className="queue-picker" data-tour="queue">
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
        <div className="tour-launch">
          <button
            ref={tourBtnRef}
            type="button"
            className="btn btn-tour"
            aria-haspopup="dialog"
            aria-expanded={tourOpen}
            onClick={openTour}
          >
            Tour
          </button>
          {showNudge && <TourNudge onStart={openTour} onDismiss={dismissNudge} />}
        </div>
        <ThemeToggle />
        <Tabs active={tab} onChange={setTab} />
      </header>

      <main className="container">
        <ProjectControls name={projectName} onNameChange={setProjectName} canSave={hasData} onSave={saveProject} onOpen={openProject} error={projectError} status={projectStatus} />
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
              text="Load data to get predicted contacts per day, a band the real number lands in 8 times in 10, half-hour volume and handle time, and the blend's three-method mix."
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
              text="Each method re-forecasts unseen weeks, scored (WAPE, MAPE, bias) per interval, day, and week, plus how accuracy fades further ahead."
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
            <StaffingTab forecast={forecast} queue={queue} horizon={horizon} theme={theme} settings={staffing} onSettingsChange={setStaffing} />
          ) : hasData ? (
            computingCard
          ) : (
            <EmptyState
              title="No data to staff against yet"
              text="Load data to see people needed per half hour, plus what-if sliders: answer-speed target, time lost to breaks and meetings, caller patience, chats per agent."
              onGoData={() => setTab('data')}
            />
          )}
        </div>
        <div hidden={tab !== 'capacity'} role="tabpanel" id="panel-capacity" aria-labelledby="tab-capacity">
          {hasData ? <CapacityTab key={datasetVersion + '|' + queue + '|' + horizon} queue={queue} forecast={forecast?.queue === queue && forecast.dailyForecast.length === horizon ? forecast : null} state={Object.prototype.hasOwnProperty.call(capacityByQueue, queue) ? capacityByQueue[queue] : emptyCapacityState()} theme={theme}
            onChange={next => setCapacityByQueue(prev => ({ ...prev, [queue]: next }))} /> : <EmptyState title="No data for capacity planning yet" text="Load data, then compare 13 weeks of demand with your headcount and a proposed hiring class." onGoData={() => setTab('data')} />}
        </div>
        <div hidden={tab !== 'intraday'} role="tabpanel" id="panel-intraday" aria-labelledby="tab-intraday">
          {hasData && forecast?.queue === queue && forecast.dailyForecast.length === horizon ? <IntradayTab key={datasetVersion + '|' + queue + '|' + horizon} forecast={forecast} queue={queue} scenario={staffing.a} theme={theme} active={tab === 'intraday'}
            state={Object.hasOwn(intradayByQueue, queue) ? intradayByQueue[queue] : emptyIntradayState()}
            onChange={next => setIntradayByQueue(prev => ({ ...prev, [queue]: next }))} /> : hasData ? computingCard : <EmptyState title="No data for intraday reforecast yet" text="Load data to compare observed contacts and remaining demand with interval staffing." onGoData={() => setTab('data')} />}
        </div>
      </main>

      <footer className="footer">
        Built by Ryan Allen. Methods: seasonal moving average, Holt-Winters, dynamic harmonic
        regression, inverse-WAPE ensemble; Erlang A/C staffing.{' '}
        <a href="https://github.com/ryanportfolio/wfm/blob/main/docs/research.md">Research notes</a>
      </footer>

      {tourOpen && (
        <GuidedTour
          tab={tab}
          hasData={hasData}
          onSelectTab={setTab}
          onLoadSample={loadSample}
          onClose={() => setTourOpen(false)}
          launcherRef={tourBtnRef}
        />
      )}
    </>
  )
}
