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
import type { IntradayInputs, IntradayResult } from '../engine/intraday'
import type { ScheduleDayRequest } from '../engine/scheduleDay'
import type { ScheduleResult } from '../engine/schedule'

/** Wording for one kind of isolated job's cancel, timeout and crash errors. */
interface JobText { cancelled: string; timeout: string; failed: string }

/**
 * Runs one request in its own short-lived worker that is terminated on
 * finish, abort or the 10-second timeout, so obsolete work never queues
 * behind the current job. Without Worker support the fallback runs on the
 * calling thread and cannot be interrupted.
 */
async function isolatedJob<T>(req: DistributiveOmit<WorkerRequest, 'id'>, text: JobText, signal: AbortSignal, fallback: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error(text.cancelled)
  if (!workerSupported()) {
    const result = await fallback()
    if (signal.aborted) throw new Error(text.cancelled)
    return result
  }
  return new Promise((resolve, reject) => {
    const job = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
    const finish = (err?: Error, result?: T) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      job.terminate()
      if (err) reject(err)
      else resolve(result!)
    }
    const cancel = () => finish(new Error(text.cancelled))
    const timer = setTimeout(() => finish(new Error(text.timeout)), 10_000)
    signal.addEventListener('abort', cancel, { once: true })
    job.onerror = e => finish(new Error(e.message || text.failed))
    job.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.kind === 'error') finish(new Error(e.data.message))
      else if (e.data.kind === 'result') finish(undefined, e.data.result as T)
    }
    job.postMessage({ ...req, id: 1 } as WorkerRequest)
  })
}

/** Isolated, cancellable job: editing cannot queue obsolete Erlang solves behind each other. */
export function intradayInWorker(points: ForecastPoint[], inputs: IntradayInputs, config: StaffingConfig, signal: AbortSignal): Promise<IntradayResult> {
  return isolatedJob<IntradayResult>({ kind: 'intraday', points, inputs, config }, {
    cancelled: 'Intraday calculation cancelled.',
    timeout: 'Intraday calculation exceeded 10 seconds. Check inputs and supported workload limits, then retry.',
    failed: 'Intraday worker failed.',
  }, signal, async () => {
    const { calculateIntraday } = await import('../engine/intraday')
    if (signal.aborted) throw new Error('Intraday calculation cancelled.')
    return calculateIntraday(points, inputs, config)
  })
}

/** Isolated, cancellable schedule build: Erlang requirement for one day, then shifts. */
export function scheduleInWorker(request: ScheduleDayRequest, signal: AbortSignal): Promise<ScheduleResult> {
  // The build budget counts from here, so worker startup and transfer time are included.
  request = { ...request, startedAt: Date.now() }
  return isolatedJob<ScheduleResult>({ kind: 'schedule', request }, {
    cancelled: 'Schedule build cancelled.',
    timeout: 'Schedule build exceeded 10 seconds. Try fewer templates, narrower start windows or a larger start step, then build again.',
    failed: 'Schedule worker failed.',
  }, signal, async () => {
    const { scheduleDay } = await import('../engine/scheduleDay')
    if (signal.aborted) throw new Error('Schedule build cancelled.')
    return scheduleDay(request)
  })
}

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
