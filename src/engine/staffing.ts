/**
 * Interval staffing grid: forecast -> Erlang requirement -> shrinkage gross-up,
 * plus pure what-if scenario application for live sliders.
 */
import type { ForecastPoint, StaffingGrid, StaffingInterval } from './types'
import { asa, erlangA, occupancy, requiredAgents, serviceLevel } from './erlang'
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
  /**
   * Fixed-staff ("what I have") mode: this many scheduled heads on every
   * interval with volume (zero-volume intervals get 0). Bodies on phones =
   * fixedScheduled * (1 - shrinkage), floored to whole agents inside
   * projectAtStaffing. `required` still holds the Erlang solve so the UI can
   * draw the target-needs reference next to the fixed staffing. Future
   * extension: accept a per-interval array here for shift-shaped staffing.
   */
  fixedScheduled?: number
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

export interface StaffingProjection {
  /** Fraction answered within slSeconds. 1 with zero volume, 0 with no staff. */
  sl: number
  /** Seconds; Infinity when nothing is ever answered or the queue is unstable. */
  asa: number
  /** Clamped to [0, 1]; an overloaded queue pins at 1. */
  occupancy: number
  /** Abandonment fraction: 0 in erlangC mode; 1 with volume and no staff (erlangA). */
  abandonPct: number
  /** Erlang C with bodies <= offered load: the queue grows without bound. */
  unstable: boolean
}

/**
 * Project SL, ASA, abandonment, and occupancy at a GIVEN body count instead of
 * solving for one; the metric formulas are the same ones requiredAgents
 * evaluates during its search. Fractional agentsOnPhones is floored: Erlang
 * math serves whole agents, and rounding down errs on the honest side.
 *
 * Edge cases:
 * - Zero volume: SL 1, everything else 0 (matches requiredAgents).
 * - Volume with no staff: SL 0, ASA Infinity, occupancy pinned at 1; with
 *   patience (erlangA) everyone abandons, without it (erlangC) the queue is
 *   flagged unstable.
 * - Erlang C with N <= A: the steady-state queue has no fixed point, so SL 0,
 *   ASA Infinity, occupancy clamped at 1, and `unstable` set so the UI can say
 *   the queue grows without bound. Erlang A is stable at any N >= 1 because
 *   abandonment sheds load.
 */
export function projectAtStaffing(
  mode: ErlangMode,
  volume: number,
  ahtSec: number,
  intervalSec: number,
  slSeconds: number,
  agentsOnPhones: number,
  patienceSec?: number,
): StaffingProjection {
  if (volume <= 0 || ahtSec <= 0) {
    return { sl: 1, asa: 0, occupancy: 0, abandonPct: 0, unstable: false }
  }
  if (!(intervalSec > 0)) throw new Error('intervalSec must be > 0')
  if (mode === 'erlangA' && !(patienceSec !== undefined && patienceSec > 0)) {
    throw new Error('erlangA mode requires patienceSec > 0')
  }
  const N = Math.floor(agentsOnPhones)
  const A = (volume * ahtSec) / intervalSec
  if (N <= 0) {
    return {
      sl: 0,
      asa: Infinity,
      occupancy: 1,
      abandonPct: mode === 'erlangA' ? 1 : 0,
      unstable: mode === 'erlangC',
    }
  }
  if (mode === 'erlangA') {
    const r = erlangA(A, N, ahtSec, patienceSec as number, slSeconds)
    return {
      sl: r.serviceLevel,
      asa: r.asa,
      occupancy: Math.min(1, r.occupancy),
      abandonPct: r.abandonProb,
      unstable: false,
    }
  }
  return {
    sl: serviceLevel(A, N, ahtSec, slSeconds),
    asa: asa(A, N, ahtSec),
    occupancy: Math.min(1, occupancy(A, N)),
    abandonPct: 0,
    unstable: N <= A,
  }
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
  const fixed = config.fixedScheduled
  if (fixed !== undefined && !(fixed >= 0)) throw new Error('fixedScheduled must be >= 0')

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
    let iv: StaffingInterval
    if (fixed !== undefined) {
      // Fixed-staff mode: heads are given, metrics are projected at them.
      const scheduled = point.offered > 0 ? fixed : 0
      const p = projectAtStaffing(
        config.mode,
        point.offered,
        effAht,
        config.intervalSec,
        config.slSeconds,
        scheduled * (1 - config.shrinkage),
        config.patienceSec,
      )
      iv = {
        ts: point.ts,
        queue,
        required: r.bodies,
        scheduled,
        occupancy: p.occupancy,
        serviceLevel: p.sl,
        asa: p.asa,
        abandonRate: p.abandonPct,
        unstable: p.unstable,
      }
    } else {
      iv = {
        ts: point.ts,
        queue,
        required: r.bodies,
        scheduled: grossUp(r.bodies, config.shrinkage),
        occupancy: r.occupancy,
        serviceLevel: r.sl,
        asa: r.asa,
        abandonRate: r.abandonPct,
      }
    }
    intervals.push(iv)
    const scheduled = iv.scheduled

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
  /** Fixed-staff mode: scheduled heads per open interval. See StaffingConfig. */
  fixedScheduled?: number
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
    ...(scenario.fixedScheduled !== undefined && { fixedScheduled: scenario.fixedScheduled }),
  }
  return buildStaffingGrid(scaled, undefined, config)
}
