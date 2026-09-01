import type { DailyPoint, IntervalRecord } from './types'
import type { QueueDay } from './series'
import { dayTotals, daysToDailyPoints, groupQueueDays } from './series'
import { usHolidays } from './holidays'

/**
 * MAD-based outlier cleaning.
 *
 * - Holidays that were closed (zero volume) are excluded from fitting
 *   entirely, tracked in the report, and forecast as zero downstream.
 * - Per (weekday, interval) cells: |x - median| > 3.5 * 1.4826 * MAD flags
 *   the cell; flagged offered values are replaced with the cell median.
 * - Per weekday on daily totals (recomputed after interval cleaning): same
 *   rule; flagged totals replaced with the weekday median.
 * - MAD = 0 (constant cells, e.g. closed slots) disables flagging for that
 *   cell rather than dividing by zero.
 */

const MAD_TO_SIGMA = 1.4826
const THRESHOLD_SIGMAS = 3.5

export interface FlaggedDay {
  date: string
  weekday: number
  original: number
  replacement: number
}

export interface FlaggedInterval {
  date: string
  time: string
  weekday: number
  original: number
  replacement: number
}

export interface CleanReport {
  queue: string
  /** US federal holiday dates inside the data range */
  holidays: string[]
  /** Holiday dates with zero volume (closed); excluded from all fitting */
  closedHolidays: string[]
  /** True when the queue closes on holidays; future holidays forecast as 0 */
  holidayClosed: boolean
  flaggedDays: FlaggedDay[]
  flaggedIntervals: FlaggedInterval[]
}

export interface CleanResult {
  /** Interval-cleaned days (totals rebuilt from cleaned intervals) */
  days: QueueDay[]
  /** Daily series after both interval- and daily-level cleaning */
  daily: DailyPoint[]
  report: CleanReport
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Returns the flagging threshold around the median, or null when MAD = 0. */
function madThreshold(values: number[]): { med: number; limit: number } | null {
  const med = median(values)
  const mad = median(values.map((v) => Math.abs(v - med)))
  if (mad === 0) return null
  return { med, limit: THRESHOLD_SIGMAS * MAD_TO_SIGMA * mad }
}

/** Clean pre-grouped days. Pure: input days are not mutated. */
export function cleanDays(days: QueueDay[], queue: string): CleanResult {
  if (days.length === 0) {
    return {
      days: [],
      daily: [],
      report: {
        queue,
        holidays: [],
        closedHolidays: [],
        holidayClosed: false,
        flaggedDays: [],
        flaggedIntervals: [],
      },
    }
  }

  const holidays = usHolidays(days[0].date, days[days.length - 1].date)
  const holidaySet = new Set(holidays)
  const closedHolidays = days.filter((d) => holidaySet.has(d.date) && d.total === 0).map((d) => d.date)
  const excluded = new Set(closedHolidays)
  const holidayCount = days.filter((d) => holidaySet.has(d.date)).length
  const holidayClosed = holidayCount > 0 && closedHolidays.length / holidayCount >= 0.5

  // Interval-level cleaning per (weekday, time-of-day) cell.
  const cellValues = new Map<string, number[]>()
  for (const day of days) {
    if (excluded.has(day.date)) continue
    for (const iv of day.intervals) {
      const key = `${day.weekday}|${iv.time}`
      let list = cellValues.get(key)
      if (!list) {
        list = []
        cellValues.set(key, list)
      }
      list.push(iv.offered)
    }
  }
  const cellRule = new Map<string, { med: number; limit: number }>()
  for (const [key, values] of cellValues) {
    const rule = madThreshold(values)
    if (rule) cellRule.set(key, rule)
  }

  const flaggedIntervals: FlaggedInterval[] = []
  const cleanedDays: QueueDay[] = days.map((day) => {
    if (excluded.has(day.date)) {
      return { ...day, intervals: day.intervals.map((iv) => ({ ...iv })) }
    }
    const intervals = day.intervals.map((iv) => {
      const rule = cellRule.get(`${day.weekday}|${iv.time}`)
      if (rule && Math.abs(iv.offered - rule.med) > rule.limit) {
        flaggedIntervals.push({
          date: day.date,
          time: iv.time,
          weekday: day.weekday,
          original: iv.offered,
          replacement: rule.med,
        })
        return { ...iv, offered: rule.med }
      }
      return { ...iv }
    })
    return { ...day, intervals, ...dayTotals(intervals) }
  })

  // Daily-level cleaning per weekday on the rebuilt totals.
  const weekdayTotals = new Map<number, number[]>()
  for (const day of cleanedDays) {
    if (excluded.has(day.date)) continue
    let list = weekdayTotals.get(day.weekday)
    if (!list) {
      list = []
      weekdayTotals.set(day.weekday, list)
    }
    list.push(day.total)
  }
  const weekdayRule = new Map<number, { med: number; limit: number }>()
  for (const [weekday, values] of weekdayTotals) {
    const rule = madThreshold(values)
    if (rule) weekdayRule.set(weekday, rule)
  }

  const flaggedDays: FlaggedDay[] = []
  const daily: DailyPoint[] = daysToDailyPoints(cleanedDays).map((p, i) => {
    if (excluded.has(p.date)) return p
    const weekday = cleanedDays[i].weekday
    const rule = weekdayRule.get(weekday)
    if (rule && Math.abs(p.total - rule.med) > rule.limit) {
      flaggedDays.push({ date: p.date, weekday, original: p.total, replacement: rule.med })
      return { ...p, total: rule.med }
    }
    return p
  })

  return {
    days: cleanedDays,
    daily,
    report: { queue, holidays, closedHolidays, holidayClosed, flaggedDays, flaggedIntervals },
  }
}

/** Clean one queue's interval records. */
export function cleanQueue(records: IntervalRecord[], queue: string): CleanResult {
  return cleanDays(groupQueueDays(records, queue), queue)
}
