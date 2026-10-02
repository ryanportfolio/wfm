/**
 * One schedule-tab job: solve the scenario's on-phone requirement for one
 * forecast day, then build shifts against it. Runs in the isolated schedule
 * worker, or on the calling thread where Worker is unavailable.
 */
import type { ForecastPoint } from './types'
import type { Scenario, StaffingConfig } from './staffing'
import { applyScenario } from './staffing'
import type { ScheduleResult, ShiftTemplate } from './schedule'
import { buildSchedule, SCHEDULE_LIMITS } from './schedule'

export interface ScheduleDayRequest {
  /** One day's interval forecast, consecutive intervals, before scenario deltas. */
  points: ForecastPoint[]
  scenario: Scenario
  baseConfig: StaffingConfig
  /** Fraction; absence, coaching, meetings. Breaks and lunch are placed by the templates. */
  unplannedShrinkage: number
  templates: ShiftTemplate[]
  /**
   * Epoch milliseconds (Date.now) when the caller started the job. Worker
   * startup, message transfer and the Erlang solve count against the build
   * budget from here. Omitted: the budget starts when scheduleDay runs.
   */
  startedAt?: number
}

/** Seed for local search; fixed so the same inputs give the same schedule. */
export const SCHEDULE_SEED = 1
/** Whole-job time budget, below the 10-second worker timeout so a result still returns. */
export const SCHEDULE_DEADLINE_MS = 8_000

/** `now` is the epoch-millisecond clock that `startedAt` uses; injectable for tests. */
export function scheduleDay(req: ScheduleDayRequest, now: () => number = Date.now): ScheduleResult {
  const started = req.startedAt ?? now()
  const { points, baseConfig } = req
  if (points.length === 0) throw new RangeError('This forecast day has no intervals.')
  const intervalMinutes = baseConfig.intervalSec / 60
  if (intervalMinutes !== 15 && intervalMinutes !== 30) {
    throw new RangeError(`The schedule builder needs 15- or 30-minute intervals; this forecast uses ${intervalMinutes}-minute intervals. Hourly data is not supported.`)
  }
  const startMs = Date.parse(points[0].ts + 'Z')
  points.forEach((p, i) => {
    if (Date.parse(p.ts + 'Z') !== startMs + i * intervalMinutes * 60_000) {
      throw new RangeError(`Forecast intervals for this day are not consecutive at ${p.ts.slice(11, 16)}; the schedule builder needs every interval of the day.`)
    }
  })
  // Required bodies are the same Erlang solve in either staffing mode; skip fixed-staff projection.
  const grid = applyScenario(points, { ...req.scenario, fixedScheduled: undefined }, baseConfig)
  const required = grid.intervals.map(iv => iv.required)
  required.forEach((r, i) => {
    if (r > SCHEDULE_LIMITS.requiredPerInterval) {
      throw new RangeError(`The ${points[i].ts.slice(11, 16)} interval needs ${r} on-phone agents; the schedule builder supports at most ${SCHEDULE_LIMITS.requiredPerInterval} per interval.`)
    }
  })
  // The builder gets whatever budget the startup and requirement solve left.
  const remaining = SCHEDULE_DEADLINE_MS - (now() - started)
  if (remaining <= 0) {
    throw new RangeError(`Solving the staffing requirement used the whole ${SCHEDULE_DEADLINE_MS / 1000}-second build budget. Check the forecast and scenario A settings, then build again.`)
  }
  return buildSchedule(
    { required, intervalMinutes, dayStart: points[0].ts, unplannedShrinkage: req.unplannedShrinkage, templates: req.templates },
    { seed: SCHEDULE_SEED, deadlineMs: remaining },
  )
}
