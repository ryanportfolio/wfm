/**
 * Promise-based client for the compute worker (src/engine/worker.ts).
 *
 * One lazy singleton worker serves the whole app. Each request gets an
 * incrementing id; responses are matched back by id via the pure helpers in
 * src/engine/workerProtocol.ts. If the worker itself errors (failed to load,
 * crashed), every in-flight request rejects and the worker respawns on the
 * next call, so the UI's normal error-and-retry path recovers it.
 *
 * Supersede story for staffing (rapid slider moves): each useGrid hook holds
 * its own staffing session; issuing a new request through a session drops the
 * session's previous in-flight request (its response is discarded by id, its
 * promise rejects with a marker the UI ignores). The worker still finishes
 * the stale solve; that costs a fraction of a second of worker time and
 * avoids terminate-and-respawn, which would also kill unrelated requests
 * sharing the worker.
 *
 * Fallback: when Worker is unavailable (vitest under node, very old
 * browsers), the engine runs in-process via dynamic import. Same signatures,
 * same results, just on the calling thread.
 */
import type { BacktestReport, IntervalRecord, ForecastPoint } from '../engine/types'
import type { BacktestOpts } from '../engine/backtest'
import type { ForecastOpts, ForecastResult } from '../engine/forecastPipeline'
import type { Scenario, StaffingConfig, StaffingGridResult } from '../engine/staffing'
import type { PendingEntry, WorkerRequest, WorkerResponse } from '../engine/workerProtocol'
import { failAll, routeMessage, supersede } from '../engine/workerProtocol'

export { isSuperseded } from '../engine/workerProtocol'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, PendingEntry>()

function workerSupported(): boolean {
  return typeof Worker !== 'undefined'
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => routeMessage(pending, e.data)
    worker.onerror = (e: ErrorEvent) => {
      failAll(pending, e.message || 'the background compute worker failed')
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

interface Issued<T> {
  id: number
  promise: Promise<T>
}

/** Omit that distributes over a union, so each request variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function post<T>(
  req: DistributiveOmit<WorkerRequest, 'id'>,
  onProgress?: (done: number, total: number) => void,
): Issued<T> {
  const id = nextId++
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress })
    ensureWorker().postMessage({ ...req, id } as WorkerRequest)
  })
  return { id, promise }
}

export async function backtestInWorker(
  records: IntervalRecord[],
  queue: string,
  opts: BacktestOpts,
  onProgress?: (fold: number, totalFolds: number) => void,
): Promise<BacktestReport[]> {
  if (!workerSupported()) {
    const { runBacktest } = await import('../engine/forecastPipeline')
    return runBacktest(records, queue, opts, onProgress)
  }
  return post<BacktestReport[]>({ kind: 'backtest', records, queue, opts }, onProgress).promise
}

export async function forecastInWorker(
  records: IntervalRecord[],
  queue: string,
  opts: ForecastOpts,
): Promise<ForecastResult> {
  if (!workerSupported()) {
    const { runForecast } = await import('../engine/forecastPipeline')
    return runForecast(records, queue, opts)
  }
  return post<ForecastResult>({ kind: 'forecast', records, queue, opts }).promise
}

export type StaffingSession = (
  intervalForecast: readonly ForecastPoint[],
  scenario: Scenario,
  baseConfig: StaffingConfig,
) => Promise<StaffingGridResult>

/**
 * A staffing request channel with latest-wins semantics: a new request drops
 * the session's previous in-flight one. Each consumer (scenario A, scenario
 * B) creates its own session so they never cancel each other.
 */
export function createStaffingSession(): StaffingSession {
  let lastId: number | null = null
  return async (intervalForecast, scenario, baseConfig) => {
    if (!workerSupported()) {
      const { applyScenario } = await import('../engine/staffing')
      return applyScenario(intervalForecast, scenario, baseConfig)
    }
    if (lastId !== null) supersede(pending, lastId)
    const issued = post<StaffingGridResult>({
      kind: 'staffing',
      intervalForecast: intervalForecast as ForecastPoint[],
      scenario,
      baseConfig,
    })
    lastId = issued.id
    const clear = () => {
      if (lastId === issued.id) lastId = null
    }
    issued.promise.then(clear, clear)
    return issued.promise
  }
}
