import type { DailyPoint, ForecastPoint } from './types'
import type { QueueDay } from './series'
import { dayNumFromIso, weekdayOfIso } from './series'

/**
 * Intraday profiles: per weekday, one share per interval of the day summing
 * to 1, built from cleaned non-holiday history with exponential decay by
 * week age (weight = PROFILE_DECAY^weeksBack). AHT forecast per
 * (weekday, interval): recency-weighted mean of historical AHT over
 * intervals that had volume, weighted by decay * offered; falls back to the
 * weekday mean, then the overall mean, when a cell has no history.
 */

export const PROFILE_DECAY = 0.92

export interface QueueProfiles {
  /** Sorted times of day, "HH:MM:SS" */
  times: string[]
  /** shares[weekday][timeIdx]; each weekday row sums to 1 (0 if no history) */
  shares: number[][]
  /** ahtByCell[weekday][timeIdx], seconds */
  ahtByCell: number[][]
}

export function buildProfiles(
  days: QueueDay[],
  excludedDates: Set<string>,
  decay: number = PROFILE_DECAY,
): QueueProfiles {
  const timeSet = new Set<string>()
  for (const day of days) for (const iv of day.intervals) timeSet.add(iv.time)
  const times = [...timeSet].sort()
  const timeIdx = new Map(times.map((t, i) => [t, i]))
  const nT = times.length

  const volume: number[][] = Array.from({ length: 7 }, () => new Array(nT).fill(0))
  const ahtNum: number[][] = Array.from({ length: 7 }, () => new Array(nT).fill(0))
  const ahtDen: number[][] = Array.from({ length: 7 }, () => new Array(nT).fill(0))

  const lastZ = days.length > 0 ? dayNumFromIso(days[days.length - 1].date) : 0
  for (const day of days) {
    if (excludedDates.has(day.date)) continue
    const weeksBack = Math.floor((lastZ - dayNumFromIso(day.date)) / 7)
    const w = Math.pow(decay, weeksBack)
    for (const iv of day.intervals) {
      const t = timeIdx.get(iv.time)!
      volume[day.weekday][t] += w * iv.offered
      if (iv.offered > 0 && iv.aht > 0) {
        ahtNum[day.weekday][t] += w * iv.offered * iv.aht
        ahtDen[day.weekday][t] += w * iv.offered
      }
    }
  }

  const shares = volume.map((row) => {
    const sum = row.reduce((a, v) => a + v, 0)
    return sum > 0 ? row.map((v) => v / sum) : row.map(() => 0)
  })

  // AHT with fallbacks: cell -> weekday mean -> overall mean -> 0.
  let overallNum = 0
  let overallDen = 0
  const weekdayMean = new Array(7).fill(0)
  for (let wd = 0; wd < 7; wd++) {
    let num = 0
    let den = 0
    for (let t = 0; t < nT; t++) {
      num += ahtNum[wd][t]
      den += ahtDen[wd][t]
    }
    weekdayMean[wd] = den > 0 ? num / den : 0
    overallNum += num
    overallDen += den
  }
  const overallMean = overallDen > 0 ? overallNum / overallDen : 0
  const ahtByCell = ahtNum.map((row, wd) =>
    row.map((num, t) => {
      if (ahtDen[wd][t] > 0) return num / ahtDen[wd][t]
      return weekdayMean[wd] > 0 ? weekdayMean[wd] : overallMean
    }),
  )

  return { times, shares, ahtByCell }
}

/**
 * Map daily totals to interval forecasts via the profiles. Offered values
 * are left unrounded so each day's intervals sum exactly to the daily total
 * (weekdays with no profile history get all-zero intervals).
 */
export function intervalize(daily: DailyPoint[], profiles: QueueProfiles): ForecastPoint[] {
  const out: ForecastPoint[] = []
  for (const day of daily) {
    const wd = weekdayOfIso(day.date)
    for (let t = 0; t < profiles.times.length; t++) {
      out.push({
        ts: `${day.date}T${profiles.times[t]}`,
        offered: day.total * profiles.shares[wd][t],
        aht: profiles.ahtByCell[wd][t],
      })
    }
  }
  return out
}
