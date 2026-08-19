import { describe, expect, it } from 'vitest'
import type { DailyPoint } from '../types'
import type { ForecastInput } from '../series'
import { addDays } from '../series'
import { fitHoltWinters, forecastHoltWinters } from './holtWinters'

// Deterministic trend + weekly seasonal series: y_t = 100 + 2t + s[t mod 7].
const SEASON = [0, 30, 20, 10, 0, -25, -35]
const truth = (t: number): number => 100 + 2 * t + SEASON[t % 7]

describe('fitHoltWinters', () => {
  const values: (number | null)[] = Array.from({ length: 210 }, (_, t) => truth(t))

  it('tracks a deterministic seasonal series near-exactly after warmup', () => {
    const fit = fitHoltWinters(values)
    let absErr = 0
    let count = 0
    for (let t = 110; t < 210; t++) {
      absErr += Math.abs((fit.fitted[t] as number) - truth(t))
      count++
    }
    // Values run 300..550 here; mean one-step error under 0.5 contacts.
    expect(absErr / count).toBeLessThan(0.5)
  })

  it('skips set-aside (null) days without breaking seasonal alignment', () => {
    const withNulls = values.slice()
    withNulls[70] = null
    withNulls[140] = null
    const fit = fitHoltWinters(withNulls)
    expect(fit.fitted[70]).toBeNull()
    let absErr = 0
    for (let t = 110; t < 210; t++) {
      if (withNulls[t] === null) continue
      absErr += Math.abs((fit.fitted[t] as number) - truth(t))
    }
    expect(absErr / 99).toBeLessThan(0.5)
  })
})

describe('forecastHoltWinters', () => {
  const start = '2025-01-06'
  const train: DailyPoint[] = Array.from({ length: 210 }, (_, t) => ({
    date: addDays(start, t),
    total: truth(t),
    aht: 300,
  }))

  it('extends trend and weekly season within 2%', () => {
    const futureDates = Array.from({ length: 14 }, (_, j) => addDays(start, 210 + j))
    const input: ForecastInput = {
      train,
      trainHolidays: new Set(),
      futureDates,
      futureHolidays: new Set(),
    }
    const out = forecastHoltWinters(input)
    for (let j = 0; j < 14; j++) {
      const expected = truth(210 + j)
      expect(Math.abs(out[j] - expected)).toBeLessThan(0.02 * expected)
    }
  })

  it('forecasts zero on future holidays', () => {
    const futureDates = [addDays(start, 210), addDays(start, 211)]
    const input: ForecastInput = {
      train,
      trainHolidays: new Set(),
      futureDates,
      futureHolidays: new Set([futureDates[0]]),
    }
    expect(forecastHoltWinters(input)[0]).toBe(0)
  })
})
