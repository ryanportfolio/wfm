import { describe, expect, it } from 'vitest'
import type { DailyPoint } from '../types'
import type { ForecastInput } from '../series'
import { dayNumFromIso, isoFromDayNum, weekdayOfDayNum } from '../series'
import type { InnerEvalDay, WeightScheme } from './ensemble'
import {
  COMPONENT_NAMES,
  HORIZON_BUCKETS,
  MIN_INNER_TRAIN_DAYS,
  bucketIndex,
  fitEnsembleWeights,
  innerFoldOrigins,
  solveWeights,
} from './ensemble'

/** Deterministic synthetic daily series with weekly shape and mild noise. */
function synthInput(nDays: number, horizon = 28): ForecastInput {
  const start = dayNumFromIso('2025-01-06')
  const train: DailyPoint[] = []
  for (let i = 0; i < nDays; i++) {
    const z = start + i
    const weekday = weekdayOfDayNum(z)
    const base = weekday === 0 || weekday === 6 ? 40 : 120 + weekday * 15
    const noise = 10 * Math.sin(i * 1.7)
    train.push({ date: isoFromDayNum(z), total: Math.max(0, base + noise), aht: 300 })
  }
  const futureDates = Array.from({ length: horizon }, (_, j) => isoFromDayNum(start + nDays + j))
  return { train, trainHolidays: new Set(), futureDates, futureHolidays: new Set() }
}

describe('bucketIndex', () => {
  it('maps boundary days to the right buckets', () => {
    expect(bucketIndex(1)).toBe(0)
    expect(bucketIndex(3)).toBe(0)
    expect(bucketIndex(4)).toBe(1)
    expect(bucketIndex(14)).toBe(1)
    expect(bucketIndex(15)).toBe(2)
    expect(bucketIndex(28)).toBe(2)
  })

  it('clamps days past the last bucket to the last bucket', () => {
    expect(bucketIndex(29)).toBe(HORIZON_BUCKETS.length - 1)
    expect(bucketIndex(90)).toBe(HORIZON_BUCKETS.length - 1)
  })
})

describe('innerFoldOrigins', () => {
  it('produces disjoint evaluation windows at the default step (= eval window)', () => {
    const evalDays = 28
    const origins = innerFoldOrigins(300, evalDays, 4, evalDays)
    expect(origins).toEqual([272, 244, 216, 188])
    const sorted = [...origins].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      // Window i-1 is [sorted[i-1], sorted[i-1] + evalDays); no overlap.
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(evalDays)
    }
  })

  it('drops folds whose training slice falls under the minimum', () => {
    const origins = innerFoldOrigins(160, 28, 4, 28)
    expect(origins).toEqual([132, 104])
    for (const o of origins) expect(o).toBeGreaterThanOrEqual(MIN_INNER_TRAIN_DAYS)
  })
})

describe('solveWeights', () => {
  /** Component 0 is near-perfect; 1 and 2 miss by 40% and 50%. */
  function dominantDays(): InnerEvalDay[] {
    const days: InnerEvalDay[] = []
    for (let j = 1; j <= 28; j++) {
      const actual = 100 + (j % 7) * 10
      days.push({
        bucket: bucketIndex(j),
        actual,
        forecasts: [actual * 1.02, actual * 0.6, actual * 1.5],
      })
    }
    return days
  }

  const schemes: WeightScheme[] = ['power', 'tunedPower', 'bestShrink']

  it.each(schemes)('weights sum to 1 per bucket (%s)', (scheme) => {
    const solved = solveWeights(dominantDays(), { scheme })
    expect(solved).toHaveLength(HORIZON_BUCKETS.length)
    for (const bucket of solved) {
      const sum = bucket.weights.reduce((a, v) => a + v, 0)
      expect(sum).toBeCloseTo(1, 10)
      for (const w of bucket.weights) expect(w).toBeGreaterThanOrEqual(0)
    }
  })

  it.each(schemes)('a clearly dominant component gets the dominant weight (%s)', (scheme) => {
    const solved = solveWeights(dominantDays(), { scheme })
    for (const bucket of solved) {
      expect(bucket.weights[0]).toBeGreaterThan(0.5)
      expect(bucket.weights[0]).toBeGreaterThan(bucket.weights[1])
      expect(bucket.weights[0]).toBeGreaterThan(bucket.weights[2])
    }
  })

  it('falls back to equal weights for buckets with no evaluation volume', () => {
    // Only bucket 0 has days.
    const days: InnerEvalDay[] = [
      { bucket: 0, actual: 100, forecasts: [100, 80, 120] },
      { bucket: 0, actual: 110, forecasts: [110, 90, 130] },
    ]
    const solved = solveWeights(days, { scheme: 'power' })
    expect(solved[1].wapes).toBeNull()
    expect(solved[2].wapes).toBeNull()
    for (const b of [1, 2]) {
      for (const w of solved[b].weights) expect(w).toBeCloseTo(1 / 3, 10)
    }
  })
})

describe('fitEnsembleWeights', () => {
  it('fits weights that sum to 1 per bucket with disjoint inner folds', () => {
    const weights = fitEnsembleWeights(synthInput(300))
    expect(weights.fallbackEqual).toBe(false)
    expect(weights.innerFolds).toBe(4)
    expect(weights.buckets).toHaveLength(3)
    for (const bucket of weights.buckets) {
      const sum = COMPONENT_NAMES.reduce((a, name) => a + bucket.weights[name], 0)
      expect(sum).toBeCloseTo(1, 10)
      expect(bucket.wapes).not.toBeNull()
    }
  })

  it('falls back to equal weights below the history minimum', () => {
    const weights = fitEnsembleWeights(synthInput(120))
    expect(weights.fallbackEqual).toBe(true)
    expect(weights.innerFolds).toBe(0)
    for (const bucket of weights.buckets) {
      for (const name of COMPONENT_NAMES) expect(bucket.weights[name]).toBeCloseTo(1 / 3, 10)
      expect(bucket.wapes).toBeNull()
    }
  })

  it('falls back to equal weights when fewer than two inner folds fit', () => {
    const weights = fitEnsembleWeights(synthInput(300), { innerFolds: 1 })
    expect(weights.fallbackEqual).toBe(true)
    expect(weights.innerFolds).toBe(1)
  })

  it('fits only the buckets a short horizon reaches', () => {
    const weights = fitEnsembleWeights(synthInput(300, 7))
    expect(weights.fallbackEqual).toBe(false)
    expect(weights.buckets[0].wapes).not.toBeNull()
    expect(weights.buckets[1].wapes).not.toBeNull()
    // Days 15-28 never occur in a 7-day horizon: bucket left at equal weights.
    expect(weights.buckets[2].wapes).toBeNull()
    for (const name of COMPONENT_NAMES) {
      expect(weights.buckets[2].weights[name]).toBeCloseTo(1 / 3, 10)
    }
  })

  it('scores the inner evaluation against raw totals when provided', () => {
    const input = synthInput(300)
    // Raw series with spikes the cleaned series lacks: every 10th day doubled.
    const rawTotals = input.train.map((p, i) => (i % 10 === 0 ? p.total * 2 : p.total))
    const cleanedFit = fitEnsembleWeights(input, { scheme: 'power' })
    const rawFit = fitEnsembleWeights(input, { scheme: 'power' }, rawTotals)
    expect(rawFit.fallbackEqual).toBe(false)
    // Same components, different evaluation targets: WAPEs must differ.
    const a = cleanedFit.buckets[0].wapes!
    const b = rawFit.buckets[0].wapes!
    expect(Math.abs(a.dhr - b.dhr)).toBeGreaterThan(1e-6)
  })
})
