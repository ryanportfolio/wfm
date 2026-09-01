import { describe, expect, it } from 'vitest'
import type { RelErrorSample } from './types'
import { relError } from './metrics'
import {
  MIN_BUCKET_SAMPLES,
  MIN_TOTAL_SAMPLES,
  bandForDay,
  bandQuantiles,
  quantile,
} from './intervals'
import { HORIZON_BUCKETS } from './forecast/ensemble'

describe('quantile', () => {
  it('interpolates linearly between order statistics (type 7)', () => {
    const v = [1, 2, 3, 4, 5]
    expect(quantile(v, 0)).toBe(1)
    expect(quantile(v, 0.25)).toBe(2)
    expect(quantile(v, 0.5)).toBe(3)
    expect(quantile(v, 1)).toBe(5)
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1, 12)
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9, 12)
  })

  it('handles unsorted input without mutating it', () => {
    const v = [5, 1, 3]
    expect(quantile(v, 0.5)).toBe(3)
    expect(v).toEqual([5, 1, 3])
  })

  it('degenerate inputs: single element and empty', () => {
    expect(quantile([7], 0.1)).toBe(7)
    expect(quantile([7], 0.9)).toBe(7)
    expect(Number.isNaN(quantile([], 0.5))).toBe(true)
  })

  it('clamps p outside [0, 1]', () => {
    expect(quantile([1, 2, 3], -1)).toBe(1)
    expect(quantile([1, 2, 3], 2)).toBe(3)
  })
})

describe('relError', () => {
  it('is the error relative to the forecast', () => {
    expect(relError(110, 100)).toBeCloseTo(0.1, 12)
    expect(relError(90, 100)).toBeCloseTo(-0.1, 12)
  })

  it('returns null for a ~zero forecast (closed holidays)', () => {
    expect(relError(5, 0)).toBeNull()
    expect(relError(0, 0)).toBeNull()
  })
})

/** n errors per bucket with the given symmetric spread around zero. */
function bucketErrors(perBucket: number, spreads: number[]): RelErrorSample[] {
  const out: RelErrorSample[] = []
  HORIZON_BUCKETS.forEach((b, i) => {
    for (let k = 0; k < perBucket; k++) {
      // Alternate signs, magnitudes stepping up to the bucket's spread.
      const mag = (spreads[i] * (k + 1)) / perBucket
      out.push({ lead: b.fromDay, rel: k % 2 === 0 ? mag : -mag })
    }
  })
  return out
}

describe('bandQuantiles', () => {
  it('uses per-bucket quantiles when every bucket has enough samples', () => {
    const errors = bucketErrors(20, [0.1, 0.3, 0.5])
    const bands = bandQuantiles(errors)!
    expect(bands).toHaveLength(3)
    for (const b of bands) expect(b.samples).toBe(20)
    // Wider error spread in later buckets means wider quantiles.
    expect(bands[0].qHi).toBeLessThan(bands[1].qHi)
    expect(bands[1].qHi).toBeLessThan(bands[2].qHi)
    expect(bands[0].qLo).toBeGreaterThan(bands[2].qLo)
  })

  it('always brackets zero so the band contains the point forecast', () => {
    // Every error positive: raw 10th percentile is above zero, clamp pulls qLo to 0.
    const errors: RelErrorSample[] = Array.from({ length: 30 }, (_, k) => ({
      lead: 1 + (k % 28),
      rel: 0.2 + 0.001 * k,
    }))
    const bands = bandQuantiles(errors)!
    for (const b of bands) {
      expect(b.qLo).toBe(0)
      expect(b.qHi).toBeGreaterThan(0.19)
    }
  })

  it('pools all buckets for a bucket with too few of its own samples', () => {
    // Bucket 0 gets 3 errors, buckets 1 and 2 get 20 each.
    const errors = [
      ...bucketErrors(20, [0, 0.3, 0.5]).filter((e) => e.lead > 3),
      { lead: 1, rel: 0.01 },
      { lead: 2, rel: -0.01 },
      { lead: 3, rel: 0.02 },
    ]
    const bands = bandQuantiles(errors)!
    expect(3).toBeLessThan(MIN_BUCKET_SAMPLES)
    expect(bands[0].samples).toBe(errors.length)
    expect(bands[1].samples).toBe(20)
    // The borrowed pool is wider than bucket 0's own three tiny errors.
    expect(bands[0].qHi).toBeGreaterThan(0.02)
  })

  it('returns null below the overall minimum sample count', () => {
    const few: RelErrorSample[] = Array.from({ length: MIN_TOTAL_SAMPLES - 1 }, (_, k) => ({
      lead: k + 1,
      rel: 0.1,
    }))
    expect(bandQuantiles(few)).toBeNull()
    expect(bandQuantiles([])).toBeNull()
  })
})

describe('bandForDay', () => {
  const bands = bandQuantiles(bucketErrors(20, [0.1, 0.3, 0.5]))!

  it('keeps lo <= point <= hi', () => {
    for (const lead of [1, 3, 4, 14, 15, 28]) {
      const { lo, hi } = bandForDay(200, lead, bands)
      expect(lo).toBeLessThanOrEqual(200)
      expect(hi).toBeGreaterThanOrEqual(200)
      expect(lo).toBeGreaterThanOrEqual(0)
    }
  })

  it('collapses to zero for a zero forecast', () => {
    const { lo, hi } = bandForDay(0, 5, bands)
    expect(lo).toBe(0)
    expect(hi).toBe(0)
  })

  it('clamps leads past the last bucket to the last bucket', () => {
    const at28 = bandForDay(100, 28, bands)
    const at40 = bandForDay(100, 40, bands)
    expect(at40).toEqual(at28)
  })
})
