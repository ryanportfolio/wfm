/**
 * Message protocol between the UI and the compute worker, plus the pure
 * routing helpers the client uses to match responses to requests. Everything
 * here is plain data and plain functions: no DOM, no Worker globals, so both
 * the worker entry and unit tests can import it.
 *
 * Every request carries a client-assigned incrementing id; every response
 * echoes it. Payloads are plain serializable objects (ISO-string timestamps,
 * numbers, arrays), so they cross the structured-clone boundary unchanged;
 * Infinity and NaN metric values survive structured clone too.
 */
import type { BacktestOpts } from './backtest'
import type { ForecastOpts } from './forecastPipeline'
import type { Scenario, StaffingConfig } from './staffing'
import type { ForecastPoint, IntervalRecord } from './types'

export type WorkerRequest =
  | { id: number; kind: 'backtest'; records: IntervalRecord[]; queue: string; opts: BacktestOpts }
  | { id: number; kind: 'forecast'; records: IntervalRecord[]; queue: string; opts: ForecastOpts }
  | {
      id: number
      kind: 'staffing'
      intervalForecast: ForecastPoint[]
      scenario: Scenario
      baseConfig: StaffingConfig
    }

export type WorkerResponse =
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; message: string }
  /** Backtest only: posted before each fold runs. */
  | { id: number; kind: 'progress'; done: number; total: number }

export interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onProgress?: (done: number, total: number) => void
}

/**
 * Route one worker response to its pending request. Returns false when no
 * entry matches the id (a stale response for a superseded request, or one
 * already settled): the message is dropped, by design.
 */
export function routeMessage(pending: Map<number, PendingEntry>, msg: WorkerResponse): boolean {
  const entry = pending.get(msg.id)
  if (!entry) return false
  if (msg.kind === 'progress') {
    entry.onProgress?.(msg.done, msg.total)
    return true
  }
  pending.delete(msg.id)
  if (msg.kind === 'error') entry.reject(new Error(msg.message))
  else entry.resolve(msg.result)
  return true
}

/** Reject every pending request (worker crashed or failed to load) and clear the map. */
export function failAll(pending: Map<number, PendingEntry>, message: string): void {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) entry.reject(new Error(message))
}

const SUPERSEDED_NAME = 'SupersededError'

/**
 * Drop one in-flight request because a newer one replaced it (rapid staffing
 * slider moves). The entry is removed, so the worker's eventual response for
 * this id is discarded by routeMessage; the promise rejects with a marker
 * error the UI recognizes via isSuperseded and ignores. Returns false when
 * the id was not pending.
 */
export function supersede(pending: Map<number, PendingEntry>, id: number): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  const err = new Error('superseded by a newer request')
  err.name = SUPERSEDED_NAME
  entry.reject(err)
  return true
}

/** True for the rejection supersede() produces; the UI drops it silently. */
export function isSuperseded(err: unknown): boolean {
  return err instanceof Error && err.name === SUPERSEDED_NAME
}
