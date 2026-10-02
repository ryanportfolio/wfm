import type { ForecastPoint } from '../engine/types'

/**
 * Match interval duration across staffing and capacity seeding: the smallest positive gap
 * between consecutive points on the same day, so a slot absent from one day cannot widen it.
 */
export function deriveIntervalSec(points: readonly ForecastPoint[]): number {
  const secOf = (ts: string) => Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60
  let min = Infinity
  for (let i = 1; i < points.length; i++) {
    if (points[i].ts.slice(0, 10) !== points[i - 1].ts.slice(0, 10)) continue
    const diff = secOf(points[i].ts) - secOf(points[i - 1].ts)
    if (diff > 0 && diff < min) min = diff
  }
  return Number.isFinite(min) ? min : 1800
}
