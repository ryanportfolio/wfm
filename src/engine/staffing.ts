/**
 * Interval staffing grid: forecast -> Erlang requirement -> shrinkage gross-up,
 * plus pure what-if scenario application for live sliders.
 */
import type { ForecastPoint, StaffingGrid, StaffingInterval } from './types'
import { requiredAgents } from './erlang'
import type { ErlangMode } from './erlang'

export interface StaffingConfig {
  mode: ErlangMode
  /** SL target fraction, e.g. 0.8 for 80%. */
  slPct: number
  /** SL answer-time threshold, seconds. */
  slSeconds: number
  /** Mean caller patience, seconds (erlangA mode). */
  patienceSec: number
  /** Optional abandonment cap, fraction (erlangA mode). */
  maxAbandonPct?: number
  /** Shrinkage fraction, 0 <= s < 1. Gross-up divides: scheduled = bodies / (1 - s). */
  shrinkage: number
  /** Optional occupancy cap, fraction; adds agents even when SL is met. */
  occupancyCap?: number
  /** Interval length, seconds (1800 for 30-minute intervals). */
  intervalSec: number
  /**
   * Chat concurrency (simultaneous chats per agent). Effective AHT is divided
   * by concurrency before the Erlang step, treating a multi-chat agent as one
   * faster server. Limitation: this ignores the extra service-time variability
   * of interleaved chats and assumes AHT was measured at this concurrency, so
   * calibrate AHT at the concurrency actually run (research.md section 3).
   */
  chatConcurrency?: number
  /** Queue name stamped on the grid; default ''. */
  queue?: string
}

export interface DailyFteTotal {
  /** ISO date, e.g. "2026-08-16" */
  date: string
  /** Sum over intervals of required bodies * interval hours. */
  requiredFteHours: number
  /** Sum over intervals of scheduled heads * interval hours. */
  scheduledFteHours: number
}

export interface StaffingGridResult extends StaffingGrid {
  daily: DailyFteTotal[]
}

/** Shrinkage gross-up: scheduled = bodies / (1 - shrinkage). Divide, never multiply. */
export function grossUp(bodies: number, shrinkage: number): number {
  if (!(shrinkage >= 0 && shrinkage < 1)) {
    throw new Error('shrinkage must satisfy 0 <= shrinkage < 1')
  }
  return bodies / (1 - shrinkage)
}

/**
 * Build the per-interval staffing grid from an interval forecast.
 *
 * @param intervalForecast per-interval offered (and default AHT) values
 * @param ahtForecast optional parallel AHT array (seconds); when omitted or
 *   missing an entry, the point's own aht is used
 */
export function buildStaffingGrid(
  intervalForecast: readonly ForecastPoint[],
  ahtForecast: readonly number[] | undefined,
  config: StaffingConfig,
): StaffingGridResult {
  if (!(config.shrinkage >= 0 && config.shrinkage < 1)) {
    throw new Error('shrinkage must satisfy 0 <= shrinkage < 1')
  }
  const concurrency = config.chatConcurrency ?? 1
  if (!(concurrency > 0)) throw new Error('chatConcurrency must be > 0')
  const queue = config.queue ?? ''
  const intervalHours = config.intervalSec / 3600

  const intervals: StaffingInterval[] = []
  const dailyMap = new Map<string, DailyFteTotal>()

  for (let i = 0; i < intervalForecast.length; i++) {
    const point = intervalForecast[i]
    const aht = ahtForecast?.[i] ?? point.aht
    const effAht = aht / concurrency

    const r = requiredAgents(
      config.mode,
      point.offered,
      effAht,
      config.intervalSec,
      { pct: config.slPct, seconds: config.slSeconds },
      config.patienceSec,
      config.maxAbandonPct,
      config.occupancyCap,
    )
    const scheduled = grossUp(r.bodies, config.shrinkage)

    intervals.push({
      ts: point.ts,
      queue,
      required: r.bodies,
      scheduled,
      occupancy: r.occupancy,
      serviceLevel: r.sl,
      asa: r.asa,
      abandonRate: r.abandonPct,
    })

    const date = point.ts.slice(0, 10)
    let day = dailyMap.get(date)
    if (!day) {
      day = { date, requiredFteHours: 0, scheduledFteHours: 0 }
      dailyMap.set(date, day)
    }
    day.requiredFteHours += r.bodies * intervalHours
    day.scheduledFteHours += scheduled * intervalHours
  }

  return { queue, intervals, daily: [...dailyMap.values()] }
}

export interface Scenario {
  /** Volume change in percent, e.g. +10 scales offered by 1.10. */
  volumeDeltaPct?: number
  /** AHT change in percent, e.g. -5 scales AHT by 0.95. */
  ahtDeltaPct?: number
  mode?: ErlangMode
  slPct?: number
  slSeconds?: number
  patienceSec?: number
  maxAbandonPct?: number
  shrinkage?: number
  occupancyCap?: number
  chatConcurrency?: number
}

/**
 * Apply what-if levers and rebuild the grid. Pure: scales a copy of the
 * inputs and merges config overrides, so the UI can call it on every slider
 * move without mutating the base forecast or config.
 */
export function applyScenario(
  intervalForecast: readonly ForecastPoint[],
  scenario: Scenario,
  baseConfig: StaffingConfig,
): StaffingGridResult {
  const volumeScale = 1 + (scenario.volumeDeltaPct ?? 0) / 100
  const ahtScale = 1 + (scenario.ahtDeltaPct ?? 0) / 100
  const scaled = intervalForecast.map((p) => ({
    ts: p.ts,
    offered: p.offered * volumeScale,
    aht: p.aht * ahtScale,
  }))
  const config: StaffingConfig = {
    ...baseConfig,
    ...(scenario.mode !== undefined && { mode: scenario.mode }),
    ...(scenario.slPct !== undefined && { slPct: scenario.slPct }),
    ...(scenario.slSeconds !== undefined && { slSeconds: scenario.slSeconds }),
    ...(scenario.patienceSec !== undefined && { patienceSec: scenario.patienceSec }),
    ...(scenario.maxAbandonPct !== undefined && { maxAbandonPct: scenario.maxAbandonPct }),
    ...(scenario.shrinkage !== undefined && { shrinkage: scenario.shrinkage }),
    ...(scenario.occupancyCap !== undefined && { occupancyCap: scenario.occupancyCap }),
    ...(scenario.chatConcurrency !== undefined && { chatConcurrency: scenario.chatConcurrency }),
  }
  return buildStaffingGrid(scaled, undefined, config)
}
