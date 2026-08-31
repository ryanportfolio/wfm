import type { DailyPoint, ForecastPoint, IntervalRecord } from './types'
import type { CapacityAssumptions } from './capacityTypes'
import type { StaffingConfig } from './staffing'
import { buildStaffingGrid } from './staffing'
import { erlangA, requiredAgents, serviceLevel } from './erlang'
import type { CleanResult } from './clean'
import { cleanQueue } from './clean'
import { buildProfiles, intervalize } from './profiles'
import {
  addDays,
  civilFromDays,
  dayNumFromIso,
  daysFromCivil,
  isoFromDayNum,
  weekdayOfDayNum,
  weekdayOfIso,
} from './series'

/**
 * Capacity planner demand block (module 2, docs/design-capacity.md).
 *
 * Weekly volume baseline from same-ISO-week history, trailing AHT seed, and
 * interval-true required FTE: each plan week's volume is split to weekdays by
 * historical day-of-week shares, to intervals by the module 1 intraday
 * profiles, and staffed with the module 1 Erlang engine. Shrinkage applies
 * once, in the staffing gross-up; the FTE conversion divides scheduled
 * agent-hours by paid hours per week as-is (design doc: no double count).
 *
 * Approximations, documented per function:
 * - AHT is flat across a week's intervals (the weekly assumption), not the
 *   per-cell profile AHT; at weekly grain the intraday AHT drift is
 *   second-order for FTE totals.
 * - Future holidays inside plan weeks are not zeroed; plan weeks use normal
 *   (non-holiday) day-of-week shares and profiles throughout. Capacity
 *   planning targets typical staffed weeks; module 1 handles holiday-day
 *   forecasts at daily grain.
 */

/** ISO-8601 week of the date at day number z (week 1 holds the first Thursday). */
function isoWeekParts(z: number): { isoYear: number; isoWeek: number } {
  const wd = weekdayOfDayNum(z)
  const isoWeekday = wd === 0 ? 7 : wd // 1 = Monday .. 7 = Sunday
  const thursday = z + 4 - isoWeekday
  const isoYear = civilFromDays(thursday).y
  const isoWeek = Math.floor((thursday - daysFromCivil(isoYear, 1, 1)) / 7) + 1
  return { isoYear, isoWeek }
}

/** ISO week number (1..53) of an ISO date. */
export function isoWeekOf(iso: string): number {
  return isoWeekParts(dayNumFromIso(iso)).isoWeek
}

/**
 * Mondays of the plan horizon: `weeks` consecutive week-start dates beginning
 * with the first Monday strictly after `lastHistoryDate`.
 */
export function planWeeks(lastHistoryDate: string, weeks: number): string[] {
  let z = dayNumFromIso(lastHistoryDate) + 1
  while (weekdayOfDayNum(z) !== 1) z++
  const out: string[] = []
  for (let i = 0; i < weeks; i++) out.push(isoFromDayNum(z + 7 * i))
  return out
}

/**
 * Weekly volume baseline per plan week, before growth and overrides (the
 * caller applies both). History is cleaned with cleanQueue; non-holiday daily
 * totals are summed into complete ISO weeks (weeks whose Monday..Sunday span
 * lies fully inside the history range, so partial edge weeks never bias the
 * seed). Each plan week takes the recency-weighted average of the same ISO
 * week number across history years: observations sorted oldest to newest with
 * weight doubling per year, so with 2 years the recent year weighs 2x. An ISO
 * week absent from history (e.g. week 53) falls back to the overall mean of
 * all complete weekly totals.
 */
export function seedWeeklyBaseline(
  records: IntervalRecord[],
  queue: string,
  planMondays: string[],
): Map<string, number> {
  return seedBaselineFromClean(cleanQueue(records, queue), planMondays)
}

function seedBaselineFromClean(cleaned: CleanResult, planMondays: string[]): Map<string, number> {
  const out = new Map<string, number>()
  const daily = cleaned.daily
  if (daily.length === 0) {
    for (const week of planMondays) out.set(week, 0)
    return out
  }
  const holidaySet = new Set(cleaned.report.holidays)
  const firstNum = dayNumFromIso(daily[0].date)
  const lastNum = dayNumFromIso(daily[daily.length - 1].date)

  // Non-holiday daily totals summed per week Monday; complete weeks only.
  const totalByMonday = new Map<number, number>()
  for (const p of daily) {
    if (holidaySet.has(p.date)) continue
    const z = dayNumFromIso(p.date)
    const wd = weekdayOfDayNum(z)
    const monday = z - ((wd === 0 ? 7 : wd) - 1)
    if (monday < firstNum || monday + 6 > lastNum) continue
    totalByMonday.set(monday, (totalByMonday.get(monday) ?? 0) + p.total)
  }

  const byIsoWeek = new Map<number, { isoYear: number; total: number }[]>()
  let grandTotal = 0
  for (const [monday, total] of totalByMonday) {
    const { isoYear, isoWeek } = isoWeekParts(monday)
    let list = byIsoWeek.get(isoWeek)
    if (!list) {
      list = []
      byIsoWeek.set(isoWeek, list)
    }
    list.push({ isoYear, total })
    grandTotal += total
  }
  const overallMean = totalByMonday.size > 0 ? grandTotal / totalByMonday.size : 0

  for (const week of planMondays) {
    const obs = byIsoWeek.get(isoWeekOf(week))
    if (!obs || obs.length === 0) {
      out.set(week, overallMean)
      continue
    }
    const sorted = [...obs].sort((a, b) => a.isoYear - b.isoYear)
    let num = 0
    let den = 0
    let weight = 1
    for (const o of sorted) {
      num += weight * o.total
      den += weight
      weight *= 2
    }
    out.set(week, num / den)
  }
  return out
}

/**
 * Trailing 8-week (56-day) volume-weighted AHT over the cleaned history:
 * sum(offered * aht) / sum(offered) across intervals with volume. Closed days
 * carry zero volume, so they drop out of the weighting on their own.
 */
export function seedAht(records: IntervalRecord[], queue: string): number {
  return seedAhtFromClean(cleanQueue(records, queue))
}

function seedAhtFromClean(cleaned: CleanResult): number {
  const days = cleaned.days
  if (days.length === 0) return 0
  const windowStart = dayNumFromIso(days[days.length - 1].date) - 7 * 8 + 1
  let num = 0
  let den = 0
  for (const day of days) {
    if (dayNumFromIso(day.date) < windowStart) continue
    for (const iv of day.intervals) {
      if (iv.offered > 0 && iv.aht > 0) {
        num += iv.offered * iv.aht
        den += iv.offered
      }
    }
  }
  return den > 0 ? num / den : 0
}

/**
 * Day-of-week volume shares from cleaned non-holiday history: mean daily
 * total per weekday (means, not sums, so unequal weekday counts from holiday
 * exclusion and ragged range edges cancel), normalized to sum to 1. Falls
 * back to uniform shares when history has no volume.
 */
function weekdayShares(cleaned: CleanResult): number[] {
  const holidaySet = new Set(cleaned.report.holidays)
  const sums = new Array<number>(7).fill(0)
  const counts = new Array<number>(7).fill(0)
  for (const p of cleaned.daily) {
    if (holidaySet.has(p.date)) continue
    const wd = weekdayOfIso(p.date)
    sums[wd] += p.total
    counts[wd]++
  }
  const means = sums.map((s, wd) => (counts[wd] > 0 ? s / counts[wd] : 0))
  const total = means.reduce((a, v) => a + v, 0)
  return total > 0 ? means.map((m) => m / total) : new Array<number>(7).fill(1 / 7)
}

export interface DemandWeek {
  /** Week Monday, "YYYY-MM-DD" */
  week: string
  /** Weekly volume after growth/override */
  volume: number
  /** Weekly AHT assumption, seconds */
  aht: number
  /** Scheduled agent-hours (shrinkage grossed up) / paidHoursPerWeek */
  requiredFte: number
  /**
   * Interval forecast for the week (7 days x profile times), offered split by
   * weekday shares and intraday profiles, AHT flat at the weekly assumption.
   * Reused by projectedServiceLevel.
   */
  intervals: ForecastPoint[]
}

/**
 * Demand block per plan week: volume = override ?? baseline * (1+g)^weekIndex,
 * aht = override ?? trailing seed, requiredFte computed interval-true through
 * buildStaffingGrid with the week's shrinkage (shrinkageByWeek, else
 * defaultShrinkage) replacing the config's own shrinkage. requiredFte =
 * sum(scheduled agent-intervals) * intervalHours / paidHoursPerWeek; shrinkage
 * appears once (the grid gross-up), paid hours are not derated again.
 */
export function weeklyDemand(
  records: IntervalRecord[],
  queue: string,
  assumptions: CapacityAssumptions,
  planMondays: string[],
): DemandWeek[] {
  const cleaned = cleanQueue(records, queue)
  const baseline = seedBaselineFromClean(cleaned, planMondays)
  const ahtSeed = seedAhtFromClean(cleaned)
  const shares = weekdayShares(cleaned)
  // Non-holiday profiles: a plan week is shaped like a normal staffed week.
  const profiles = buildProfiles(cleaned.days, new Set(cleaned.report.holidays))
  const growth = 1 + assumptions.growthWeeklyPct

  const out: DemandWeek[] = []
  for (let i = 0; i < planMondays.length; i++) {
    const week = planMondays[i]
    const volume =
      assumptions.volumeOverrides.get(week) ?? (baseline.get(week) ?? 0) * Math.pow(growth, i)
    const aht = assumptions.ahtOverrides.get(week) ?? ahtSeed

    const dailyPoints: DailyPoint[] = []
    for (let d = 0; d < 7; d++) {
      const date = addDays(week, d)
      dailyPoints.push({ date, total: volume * shares[weekdayOfIso(date)], aht })
    }
    const intervals = intervalize(dailyPoints, profiles).map((p) => ({ ...p, aht }))

    const config: StaffingConfig = {
      ...assumptions.staffing,
      shrinkage: assumptions.shrinkageByWeek.get(week) ?? assumptions.defaultShrinkage,
    }
    const grid = buildStaffingGrid(intervals, undefined, config)
    let scheduledHours = 0
    for (const day of grid.daily) scheduledHours += day.scheduledFteHours

    out.push({ week, volume, aht, requiredFte: scheduledHours / assumptions.paidHoursPerWeek, intervals })
  }
  return out
}

/**
 * Projected weekly service level delivered by a given FTE supply (design doc
 * "Bottom line": invert the staffing engine).
 *
 * Supply FTE -> scheduled agent-hours (x paidHoursPerWeek, paid hours as-is),
 * de-grossed by the week's shrinkage to bodies-on-phones hours, converted to
 * integer agent-intervals and allocated across intervals proportional to the
 * per-interval required bodies (recomputed with the same Erlang config the
 * demand side used), rounded by largest remainder. Each interval's SL is then
 * evaluated at its allocated agent count and volume-weighted into a weekly SL.
 *
 * Approximations:
 * - Proportional-to-requirement allocation assumes scheduling can shape
 *   coverage exactly like the requirement curve (no shift constraints).
 * - Agents are integers per interval (largest-remainder rounding); an
 *   interval allocated 0 agents with volume > 0 scores SL 0.
 * - At supply equal to the demand-side requiredFte the allocation reproduces
 *   the required bodies exactly, so the weekly SL meets the target.
 */
export function projectedServiceLevel(
  intervals: readonly ForecastPoint[],
  supplyFte: number,
  shrinkage: number,
  staffing: StaffingConfig,
  paidHoursPerWeek: number,
): number {
  if (!(shrinkage >= 0 && shrinkage < 1)) {
    throw new Error('shrinkage must satisfy 0 <= shrinkage < 1')
  }
  const concurrency = staffing.chatConcurrency ?? 1
  const intervalHours = staffing.intervalSec / 3600

  let totalOffered = 0
  for (const p of intervals) totalOffered += p.offered
  if (totalOffered <= 0) return 1

  // Required bodies per interval, mirroring buildStaffingGrid's Erlang step.
  const required = intervals.map((p) => {
    if (p.offered <= 0 || p.aht <= 0) return 0
    return requiredAgents(
      staffing.mode,
      p.offered,
      p.aht / concurrency,
      staffing.intervalSec,
      { pct: staffing.slPct, seconds: staffing.slSeconds },
      staffing.patienceSec,
      staffing.maxAbandonPct,
      staffing.occupancyCap,
    ).bodies
  })
  const sumRequired = required.reduce((a, v) => a + v, 0)
  if (sumRequired === 0) return 1

  // Bodies-on-phones agent-intervals available from the supply.
  const bodyIntervals = (supplyFte * paidHoursPerWeek * (1 - shrinkage)) / intervalHours
  const T = Math.max(0, Math.round(bodyIntervals))

  // Largest-remainder allocation proportional to required bodies. The small
  // epsilon keeps exact-integer raw shares (supply == requirement) from
  // flooring down on float noise.
  const raw = required.map((r) => (T * r) / sumRequired)
  const alloc = raw.map((x) => Math.floor(x + 1e-9))
  let remaining = T - alloc.reduce((a, v) => a + v, 0)
  if (remaining > 0) {
    const order = raw
      .map((x, idx) => ({ frac: x - Math.floor(x + 1e-9), idx }))
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx)
    for (let j = 0; j < order.length && remaining > 0; j++) {
      alloc[order[j].idx]++
      remaining--
    }
  }

  let weighted = 0
  for (let i = 0; i < intervals.length; i++) {
    const p = intervals[i]
    if (p.offered <= 0) continue
    let sl: number
    if (alloc[i] <= 0) {
      sl = 0
    } else if (p.aht <= 0) {
      sl = 1
    } else {
      const effAht = p.aht / concurrency
      const A = (p.offered * effAht) / staffing.intervalSec
      sl =
        staffing.mode === 'erlangA'
          ? erlangA(A, alloc[i], effAht, staffing.patienceSec, staffing.slSeconds).serviceLevel
          : serviceLevel(A, alloc[i], effAht, staffing.slSeconds)
    }
    weighted += p.offered * sl
  }
  return weighted / totalOffered
}
