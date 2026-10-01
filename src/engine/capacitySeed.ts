import type { ForecastPoint, IntervalRecord } from './types'
import type { DailyFteTotal, Scenario, StaffingConfig } from './staffing'
import { applyScenario } from './staffing'
import { cleanQueue } from './clean'
import { usHolidays } from './holidays'
import { CAPACITY_WEEKS } from './capacity'
import { addDays, civilFromDays, dayNumFromIso, daysFromCivil, isoFromDayNum, weekdayOfDayNum } from './series'

/**
 * Capacity demand seeded from the same ISO week of history.
 *
 * 1. History is cleaned with cleanQueue (interval outliers replaced by cell medians).
 * 2. Eligible history weeks are complete Monday-to-Sunday weeks inside the queue's
 *    date range that end before the plan start. Dates absent inside that range count
 *    as zero volume, as elsewhere in the app.
 * 3. Each plan week averages the eligible weeks with its ISO week number. Weight
 *    doubles per more recent ISO year: 2^(year - newest year), normalized. An ISO
 *    week absent from history (e.g. week 53) uses the equal-weight mean of all eligible weeks.
 * 4. Growth compounds per week of distance: a history week starting d weeks before
 *    the plan week is scaled by (1 + g)^d. Distance is measured to each plan week,
 *    so a fallback week-13 seed grows 12 weeks more than week 1 from the same history week.
 * 5. Averaging happens per interval slot (day of week and time): offered is the
 *    weighted, grown mean; AHT is the matching volume-weighted mean. The result is an
 *    interval forecast for 13 plan weeks, which the caller staffs exactly like a
 *    forecast seed. Required on-contact hours per plan week divided by paid hours
 *    per week give productive FTE.
 *
 * Holiday weeks stay in: a holiday usually falls in the same ISO week each year, so the
 * same-week history carries its shape. Each plan week flags whether any contributing week
 * or the plan week itself contains a US federal holiday (actual or observed date); when
 * the flags differ, the seed is a holiday mismatch to review. A fallback week reports no
 * history holiday: the all-weeks mean carries no single holiday's shape, so a plan holiday
 * in a fallback week is flagged. Closures are not zeroed.
 */

/** Weekly growth is a compound rate per week, within +/-5%. */
export const HISTORY_SEED_MAX_WEEKLY_GROWTH = 0.05

export interface HistorySeedContributor {
  /** Monday of the history week */
  start: string
  /** Normalized weight; contributors of one plan week sum to 1 */
  weight: number
  /** Whole weeks from this history week to the plan week */
  weeksBefore: number
  /** (1 + g)^weeksBefore */
  growthFactor: number
  /** The history week contains a US federal holiday (actual or observed date). */
  holiday: boolean
}

export interface HistorySeedWeek {
  /** 1-based plan week */
  week: number
  /** Monday of the plan week */
  start: string
  isoYear: number
  isoWeek: number
  /** sameIsoWeek: same ISO week of history; allWeeksMean: fallback mean */
  source: 'sameIsoWeek' | 'allWeeksMean'
  /** Oldest first */
  contributors: HistorySeedContributor[]
  /** Any contributing same-ISO-week history week contains a federal holiday; always false for allWeeksMean. */
  holidayInHistory: boolean
  /** The plan week contains a federal holiday. Differing flags mean a holiday mismatch. */
  holidayInPlan: boolean
}

export interface HistorySeed {
  planStart: string
  weeklyGrowth: number
  weeks: HistorySeedWeek[]
  /** Seeded interval demand for all 13 plan weeks, sorted by timestamp */
  intervalForecast: ForecastPoint[]
}

function isoWeekOfDayNum(z: number): { isoYear: number; isoWeek: number } {
  const wd = weekdayOfDayNum(z)
  const thursday = z + 4 - (wd === 0 ? 7 : wd)
  const isoYear = civilFromDays(thursday).y
  return { isoYear, isoWeek: Math.floor((thursday - daysFromCivil(isoYear, 1, 1)) / 7) + 1 }
}

/** ISO-8601 year and week (week 1 holds the first Thursday) of an ISO date. */
export function isoWeekOf(date: string): { isoYear: number; isoWeek: number } {
  return isoWeekOfDayNum(dayNumFromIso(date))
}

/** First Monday strictly after the queue's last history date. */
export function firstPlanMonday(records: readonly IntervalRecord[], queue: string): string {
  let last = ''
  for (const r of records) if (r.queue === queue && r.ts.slice(0, 10) > last) last = r.ts.slice(0, 10)
  if (!last) throw new Error(`No history for queue "${queue}".`)
  let z = dayNumFromIso(last) + 1
  while (weekdayOfDayNum(z) !== 1) z++
  return isoFromDayNum(z)
}

interface Slot { offered: number; work: number }

export function buildHistorySeed(records: IntervalRecord[], queue: string, planStart: string, weeklyGrowth: number): HistorySeed {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planStart) || isoFromDayNum(dayNumFromIso(planStart)) !== planStart
    || weekdayOfDayNum(dayNumFromIso(planStart)) !== 1) throw new RangeError('Plan start must be a real ISO date on a Monday.')
  if (!Number.isFinite(weeklyGrowth) || Math.abs(weeklyGrowth) > HISTORY_SEED_MAX_WEEKLY_GROWTH) {
    throw new RangeError(`Weekly growth must be between -${HISTORY_SEED_MAX_WEEKLY_GROWTH * 100}% and ${HISTORY_SEED_MAX_WEEKLY_GROWTH * 100}%.`)
  }
  const cleaned = cleanQueue(records, queue)
  const planNum = dayNumFromIso(planStart)
  const holidays = new Set(cleaned.report.holidays)
  const history: { monday: number; isoYear: number; isoWeek: number; holiday: boolean; slots: Map<string, Slot> }[] = []
  const days = cleaned.days
  for (let i = 0; i < days.length; i++) {
    if (days[i].weekday !== 1 || i + 7 > days.length) continue
    const monday = dayNumFromIso(days[i].date)
    if (monday + 6 >= planNum) continue
    const week = days.slice(i, i + 7)
    const slots = new Map<string, Slot>()
    week.forEach((day, offset) => {
      for (const iv of day.intervals) slots.set(`${offset}|${iv.time}`, { offered: iv.offered, work: iv.offered * iv.aht })
    })
    history.push({ monday, ...isoWeekOfDayNum(monday), holiday: week.some(d => holidays.has(d.date)), slots })
  }
  if (!history.length) {
    throw new Error('History seed needs at least one complete Monday-to-Sunday week before the plan start.')
  }

  const planHolidays = usHolidays(planStart, isoFromDayNum(planNum + 7 * CAPACITY_WEEKS - 1)).map(dayNumFromIso)
  const weeks: HistorySeedWeek[] = []
  const intervalForecast: ForecastPoint[] = []
  for (let w = 0; w < CAPACITY_WEEKS; w++) {
    const monday = planNum + 7 * w
    const { isoYear, isoWeek } = isoWeekOfDayNum(monday)
    const same = history.filter(h => h.isoWeek === isoWeek)
    const used = same.length ? same : history
    const newest = Math.max(...used.map(h => h.isoYear))
    const raw = used.map(h => same.length ? 2 ** (h.isoYear - newest) : 1)
    const total = raw.reduce((sum, v) => sum + v, 0)
    const contributors = used.map((h, i) => {
      const weeksBefore = (monday - h.monday) / 7
      return { start: isoFromDayNum(h.monday), weight: raw[i] / total, weeksBefore, growthFactor: (1 + weeklyGrowth) ** weeksBefore, holiday: h.holiday }
    })
    const slots = new Map<string, Slot>()
    used.forEach((h, i) => {
      const scale = contributors[i].weight * contributors[i].growthFactor
      for (const [key, s] of h.slots) {
        const slot = slots.get(key) ?? { offered: 0, work: 0 }
        slot.offered += scale * s.offered
        slot.work += scale * s.work
        slots.set(key, slot)
      }
    })
    const start = isoFromDayNum(monday)
    const points = [...slots].map(([key, s]) => {
      const [offset, time] = key.split('|')
      return { ts: `${addDays(start, Number(offset))}T${time}`, offered: s.offered, aht: s.offered > 0 ? s.work / s.offered : 0 }
    })
    intervalForecast.push(...points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)))
    weeks.push({ week: w + 1, start, isoYear, isoWeek, source: same.length ? 'sameIsoWeek' : 'allWeeksMean', contributors,
      holidayInHistory: same.some(h => h.holiday), holidayInPlan: planHolidays.some(z => z >= monday && z < monday + 7) })
  }
  return { planStart, weeklyGrowth, weeks, intervalForecast }
}

/** Sums required on-contact hours into consecutive seven-day weeks from start. */
export function weeklyRequirementHours(daily: readonly DailyFteTotal[], start: string, weeks: number): number[] {
  const hours = Array(weeks).fill(0) as number[]
  for (const day of daily) {
    const week = Math.floor((dayNumFromIso(day.date) - dayNumFromIso(start)) / 7)
    if (week >= 0 && week < weeks) hours[week] += day.requiredFteHours
  }
  return hours
}

export interface HistoryDemandSeed {
  seed: HistorySeed
  requirementHours: number[]
  requiredProductiveFte: number[]
}

/** Synchronous seed: staffing through applyScenario, then hours / paid hours per week. */
export function seedDemandFromHistory(records: IntervalRecord[], queue: string, options: {
  planStart: string; weeklyGrowth: number; paidHoursPerWeek: number; scenario: Scenario; config: StaffingConfig
}): HistoryDemandSeed {
  if (!(options.paidHoursPerWeek > 0 && options.paidHoursPerWeek <= 168)) throw new RangeError('Paid hours per week must be greater than 0 and at most 168.')
  const seed = buildHistorySeed(records, queue, options.planStart, options.weeklyGrowth)
  const grid = applyScenario(seed.intervalForecast, options.scenario, options.config)
  const requirementHours = weeklyRequirementHours(grid.daily, seed.planStart, CAPACITY_WEEKS)
  return { seed, requirementHours, requiredProductiveFte: requirementHours.map(h => h / options.paidHoursPerWeek) }
}
