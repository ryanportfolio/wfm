import { describe, expect, it } from 'vitest'
import type { DailyPoint } from '../types'
import type { ForecastInput } from '../series'
import { addDays, weekdayOfIso } from '../series'
import { forecastSma, smaValue } from './sma'

describe('smaValue', () => {
  it('drops min and max, then recency-weights the survivors', () => {
    // Most recent first; 200 (max) and 50 (min) are trimmed.
    const values = [100, 102, 98, 104, 96, 200, 50, 101]
    const d = 0.85
    const num =
      100 * 1 + 102 * d + 98 * d ** 2 + 104 * d ** 3 + 96 * d ** 4 + 101 * d ** 7
    const den = 1 + d + d ** 2 + d ** 3 + d ** 4 + d ** 7
    expect(smaValue(values)).toBeCloseTo(num / den, 10)
  })

  it('is exact on constant history', () => {
    expect(smaValue([100, 100, 100, 100, 100, 100, 100, 100])).toBe(100)
  })

  it('does not trim with fewer than 3 occurrences', () => {
    // Plain recency-weighted mean of [120, 80].
    expect(smaValue([120, 80])).toBeCloseTo((120 + 80 * 0.85) / 1.85, 10)
  })

  it('returns 0 on empty history', () => {
    expect(smaValue([])).toBe(0)
  })
})

describe('forecastSma', () => {
  // 56 contiguous days from a Sunday; value depends only on weekday,
  // except two Mondays overridden to 200 and 50 (trimmed away).
  const start = '2025-01-05' // Sunday
  const train: DailyPoint[] = []
  for (let i = 0; i < 56; i++) {
    const date = addDays(start, i)
    let total = 100 + 10 * weekdayOfIso(date)
    if (date === '2025-01-13') total = 200
    if (date === '2025-02-03') total = 50
    train.push({ date, total, aht: 300 })
  }

  it('recovers the per-weekday constants and ignores trimmed outliers', () => {
    const input: ForecastInput = {
      train,
      trainHolidays: new Set(),
      futureDates: ['2025-03-02', '2025-03-03'], // Sunday, Monday
      futureHolidays: new Set(),
    }
    const out = forecastSma(input)
    expect(out[0]).toBeCloseTo(100, 10) // Sunday
    expect(out[1]).toBeCloseTo(110, 10) // Monday: 200 and 50 trimmed
  })

  it('forecasts zero on future holidays', () => {
    const input: ForecastInput = {
      train,
      trainHolidays: new Set(),
      futureDates: ['2025-03-02', '2025-03-03'],
      futureHolidays: new Set(['2025-03-03']),
    }
    expect(forecastSma(input)[1]).toBe(0)
  })
})
