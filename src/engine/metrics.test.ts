import { describe, expect, it } from 'vitest'
import { bias, mape, wape } from './metrics'

describe('wape', () => {
  it('matches hand-computed value', () => {
    // |110-100| + |190-200| + |330-300| = 50; sum actual = 600
    expect(wape([100, 200, 300], [110, 190, 330])).toBeCloseTo(50 / 600, 12)
  })

  it('is 0 for a perfect forecast', () => {
    expect(wape([5, 10], [5, 10])).toBe(0)
  })

  it('is NaN when actuals sum to zero', () => {
    expect(wape([0, 0], [1, 2])).toBeNaN()
  })

  it('throws on length mismatch', () => {
    expect(() => wape([1], [1, 2])).toThrow()
  })
})

describe('mape', () => {
  it('skips actual = 0 points and reports coverage', () => {
    // Scored points: (|110-100|/100 + |180-200|/200) / 2 = (0.1 + 0.1) / 2
    const result = mape([100, 0, 200], [110, 50, 180])
    expect(result.mape).toBeCloseTo(0.1, 12)
    expect(result.coverage).toBeCloseTo(2 / 3, 12)
  })

  it('is NaN with zero coverage', () => {
    const result = mape([0, 0], [1, 2])
    expect(result.mape).toBeNaN()
    expect(result.coverage).toBe(0)
  })
})

describe('bias', () => {
  it('matches hand-computed value', () => {
    // (90 + 120 - 200) / 200 = 0.05
    expect(bias([100, 100], [90, 120])).toBeCloseTo(0.05, 12)
  })

  it('is negative when under-forecasting', () => {
    expect(bias([100, 100], [80, 100])).toBeCloseTo(-0.1, 12)
  })

  it('is NaN when actuals sum to zero', () => {
    expect(bias([0, 0], [1, 1])).toBeNaN()
  })
})
