import type { BandQuantiles, RelErrorSample } from './types'
import { HORIZON_BUCKETS, bucketIndex } from './forecast/ensemble'

/**
 * Empirical prediction intervals from rolling-origin fold errors.
 *
 * Design:
 * - Each scored fold day yields one relative error (actual - forecast) /
 *   forecast (see relError in metrics.ts). Days with a ~zero forecast (closed
 *   holidays) are dropped, so the closed-day zeros cannot fake precision.
 * - Errors are pooled per horizon bucket (1-3d, 4-14d, 15-28d, the same
 *   buckets the ensemble weights use) rather than per lead day: with 8 outer
 *   folds a single lead day has only 8 errors, while the buckets pool 24, 88,
 *   and 112, enough for stable tail quantiles.
 * - The 10th and 90th percentiles of a bucket's pooled errors give the ~80%
 *   band multipliers. The band for a forecast F at lead day L is
 *   [F * (1 + qLo), F * (1 + qHi)] with L's bucket quantiles.
 * - qLo is clamped to <= 0 and qHi to >= 0, so the band always contains the
 *   point forecast. Clamping only ever widens the band; a one-sided error
 *   distribution (persistent bias) still shows as a lopsided band.
 * - Small-sample care: a bucket with fewer than MIN_BUCKET_SAMPLES errors
 *   borrows the pool of all buckets; below MIN_TOTAL_SAMPLES overall no band
 *   is produced and callers fall back to lo = hi = point.
 */

/** Quantile probabilities for the ~80% band. */
export const BAND_LO_P = 0.1
export const BAND_HI_P = 0.9
/** A bucket needs this many pooled errors before its own quantiles are trusted. */
export const MIN_BUCKET_SAMPLES = 10
/** Below this many errors overall, no band is produced at all. */
export const MIN_TOTAL_SAMPLES = 5

/**
 * Empirical quantile with linear interpolation between order statistics
 * (type 7, the numpy/R default). p is clamped to [0, 1]. NaN on empty input.
 */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Per-bucket 80% band quantiles from pooled fold errors, or null when there
 * are too few errors to calibrate anything.
 */
export function bandQuantiles(errors: RelErrorSample[]): BandQuantiles[] | null {
  if (errors.length < MIN_TOTAL_SAMPLES) return null
  const allRel = errors.map((e) => e.rel)
  return HORIZON_BUCKETS.map((bucket, b) => {
    const own = errors.filter((e) => bucketIndex(e.lead) === b).map((e) => e.rel)
    const pool = own.length >= MIN_BUCKET_SAMPLES ? own : allRel
    return {
      label: bucket.label,
      fromDay: bucket.fromDay,
      toDay: bucket.toDay,
      samples: pool.length,
      qLo: Math.min(0, quantile(pool, BAND_LO_P)),
      qHi: Math.max(0, quantile(pool, BAND_HI_P)),
    }
  })
}

/**
 * Band edges for one forecast day. `lead` is 1-based; days past the last
 * bucket use the last bucket (bucketIndex clamps). Guarantees
 * 0 <= lo <= total <= hi for total >= 0.
 */
export function bandForDay(
  total: number,
  lead: number,
  bands: BandQuantiles[],
): { lo: number; hi: number } {
  const b = bands[bucketIndex(lead)]
  const lo = Math.max(0, total * (1 + b.qLo))
  const hi = Math.max(lo, total * (1 + b.qHi))
  return { lo, hi }
}
