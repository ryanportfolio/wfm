import type { DailyPoint, DailySeries, IntervalRecord } from './types'

// Calendar math on day numbers (days since 1970-01-01), no Date objects,
// so results are identical regardless of host timezone. Same algorithm as
// sampleData.ts (Howard Hinnant's civil-days conversion).

export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: y + (m <= 2 ? 1 : 0), m, d }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function dayNumFromIso(iso: string): number {
  return daysFromCivil(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)))
}

export function isoFromDayNum(z: number): string {
  const { y, m, d } = civilFromDays(z)
  return `${y}-${pad2(m)}-${pad2(d)}`
}

export function addDays(iso: string, n: number): string {
  return isoFromDayNum(dayNumFromIso(iso) + n)
}

/** 0 = Sunday .. 6 = Saturday */
export function weekdayOfDayNum(z: number): number {
  return ((z % 7) + 11) % 7
}

/** 0 = Sunday .. 6 = Saturday */
export function weekdayOfIso(iso: string): number {
  return weekdayOfDayNum(dayNumFromIso(iso))
}

/** "2026-08-16T09:30:00" -> "2026-08-16" */
export function datePart(ts: string): string {
  return ts.slice(0, 10)
}

/** "2026-08-16T09:30:00" -> "09:30:00" (seconds normalized in) */
export function timePart(ts: string): string {
  const t = ts.slice(11)
  return t.length === 5 ? `${t}:00` : t
}

export interface QueueDayInterval {
  /** Time of day, "HH:MM:SS" */
  time: string
  offered: number
  aht: number
}

export interface QueueDay {
  date: string
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number
  /** Sorted by time of day */
  intervals: QueueDayInterval[]
  /** Total offered for the day */
  total: number
  /** AHT-weighted daily mean, seconds (0 when total is 0) */
  aht: number
}

/**
 * Group one queue's interval records into per-day buckets covering every
 * calendar date from the first to the last record (missing dates become
 * zero-volume days so downstream weekly seasonality stays aligned).
 */
export function groupQueueDays(records: IntervalRecord[], queue: string): QueueDay[] {
  const byDate = new Map<string, QueueDayInterval[]>()
  for (const r of records) {
    if (r.queue !== queue) continue
    const date = datePart(r.ts)
    let list = byDate.get(date)
    if (!list) {
      list = []
      byDate.set(date, list)
    }
    list.push({ time: timePart(r.ts), offered: r.offered, aht: r.aht })
  }
  if (byDate.size === 0) return []

  const dates = [...byDate.keys()].sort()
  const startNum = dayNumFromIso(dates[0])
  const endNum = dayNumFromIso(dates[dates.length - 1])
  const days: QueueDay[] = []
  for (let z = startNum; z <= endNum; z++) {
    const date = isoFromDayNum(z)
    const intervals = (byDate.get(date) ?? []).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    days.push({ date, weekday: weekdayOfDayNum(z), intervals, ...dayTotals(intervals) })
  }
  return days
}

export function dayTotals(intervals: QueueDayInterval[]): { total: number; aht: number } {
  let total = 0
  let ahtWeighted = 0
  for (const iv of intervals) {
    total += iv.offered
    ahtWeighted += iv.offered * iv.aht
  }
  return { total, aht: total > 0 ? ahtWeighted / total : 0 }
}

export function daysToDailyPoints(days: QueueDay[]): DailyPoint[] {
  return days.map((d) => ({ date: d.date, total: d.total, aht: d.aht }))
}

/** Aggregate interval records into a per-queue daily series (contiguous dates). */
export function toDailySeries(records: IntervalRecord[], queue: string): DailySeries {
  return { queue, points: daysToDailyPoints(groupQueueDays(records, queue)) }
}

/**
 * Common input for the daily forecast components. `train` must be contiguous
 * calendar days; dates in `trainHolidays` are excluded from fitting.
 * `futureDates` must be contiguous days starting the day after the last
 * training day; dates in `futureHolidays` are forecast as zero.
 * `calendarHolidays` carries every calendar holiday in the train + future
 * span regardless of closure, so covariate models can learn holiday and
 * post-holiday effects on queues that stay open; when omitted it defaults to
 * trainHolidays plus futureHolidays.
 */
export interface ForecastInput {
  train: DailyPoint[]
  trainHolidays: Set<string>
  futureDates: string[]
  futureHolidays: Set<string>
  calendarHolidays?: Set<string>
}
