import type { ForecastInput } from '../series'
import { weekdayOfIso } from '../series'

/**
 * Seasonal moving average on daily totals: for each future date, take the
 * last SMA_OCCURRENCES same-weekday training days (closed holidays excluded),
 * drop the single min and single max occurrence (ties resolved to the most
 * recent tied occurrence), then compute a recency-weighted mean of the
 * survivors with weight SMA_DECAY^k where k is the occurrence age in weeks
 * (0 = most recent). Future holidays are forecast as zero.
 */

export const SMA_OCCURRENCES = 8
export const SMA_DECAY = 0.85

/**
 * Trimmed, recency-weighted mean of one weekday's occurrence values,
 * ordered most recent first.
 */
export function smaValue(recentFirst: number[]): number {
  const n = recentFirst.length
  if (n === 0) return 0
  let minIdx = -1
  let maxIdx = -1
  if (n >= 3) {
    minIdx = 0
    for (let i = 1; i < n; i++) {
      if (recentFirst[i] < recentFirst[minIdx]) minIdx = i
    }
    maxIdx = minIdx === 0 ? 1 : 0
    for (let i = 0; i < n; i++) {
      if (i !== minIdx && recentFirst[i] > recentFirst[maxIdx]) maxIdx = i
    }
  }
  let num = 0
  let den = 0
  for (let k = 0; k < n; k++) {
    if (k === minIdx || k === maxIdx) continue
    const w = Math.pow(SMA_DECAY, k)
    num += recentFirst[k] * w
    den += w
  }
  return den > 0 ? num / den : 0
}

export function forecastSma(input: ForecastInput): number[] {
  // Per weekday: training values most recent first, closed holidays excluded.
  const byWeekday: number[][] = Array.from({ length: 7 }, () => [])
  for (let i = input.train.length - 1; i >= 0; i--) {
    const p = input.train[i]
    if (input.trainHolidays.has(p.date)) continue
    const w = weekdayOfIso(p.date)
    if (byWeekday[w].length < SMA_OCCURRENCES) byWeekday[w].push(p.total)
  }
  const valueByWeekday = byWeekday.map((values) => Math.max(0, smaValue(values)))
  return input.futureDates.map((date) =>
    input.futureHolidays.has(date) ? 0 : valueByWeekday[weekdayOfIso(date)],
  )
}
