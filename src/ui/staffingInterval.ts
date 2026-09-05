import type { ForecastPoint } from '../engine/types'

/** Match interval duration across staffing and capacity seeding. */
export function deriveIntervalSec(points: readonly ForecastPoint[]): number {
  if (points.length >= 2 && points[0].ts.slice(0, 10) === points[1].ts.slice(0, 10)) {
    const secOf = (ts: string) => Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60
    const diff = secOf(points[1].ts) - secOf(points[0].ts)
    if (diff > 0) return diff
  }
  return 1800
}
