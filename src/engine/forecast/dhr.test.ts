import { describe, expect, it } from 'vitest'
import type { DailyPoint } from '../types'
import type { ForecastInput } from '../series'
import { addDays, dayNumFromIso } from '../series'
import { forecastDhr, solveLinearSystem } from './dhr'
import { wape } from '../metrics'

describe('solveLinearSystem', () => {
  it('solves a small system exactly', () => {
    // 2x + y = 5; x + 3y = 10 -> x = 1, y = 3
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    )
    expect(x[0]).toBeCloseTo(1, 10)
    expect(x[1]).toBeCloseTo(3, 10)
  })

  it('pivots when the leading entry is zero', () => {
    // y = 4; x + y = 7 -> x = 3, y = 4
    const x = solveLinearSystem(
      [
        [0, 1],
        [1, 1],
      ],
      [4, 7],
    )
    expect(x[0]).toBeCloseTo(3, 10)
    expect(x[1]).toBeCloseTo(4, 10)
  })
})

describe('forecastDhr', () => {
  it('recovers a known Fourier + trend series within 2% WAPE', () => {
    const start = '2024-01-01'
    const startZ = dayNumFromIso(start)
    const truth = (z: number): number =>
      200 +
      0.3 * (z - startZ) +
      30 * Math.sin((2 * Math.PI * z) / 7) +
      15 * Math.cos((2 * Math.PI * z) / 7) +
      20 * Math.sin((2 * Math.PI * z) / 365.25)

    const train: DailyPoint[] = Array.from({ length: 420 }, (_, t) => ({
      date: addDays(start, t),
      total: truth(startZ + t),
      aht: 300,
    }))
    const futureDates = Array.from({ length: 28 }, (_, j) => addDays(start, 420 + j))
    const input: ForecastInput = {
      train,
      trainHolidays: new Set(),
      futureDates,
      futureHolidays: new Set(),
    }
    const out = forecastDhr(input)
    const expected = futureDates.map((d) => truth(dayNumFromIso(d)))
    expect(wape(expected, out)).toBeLessThan(0.02)
  })

  it('forecasts zero on future holidays and floors at zero', () => {
    const start = '2024-01-01'
    const train: DailyPoint[] = Array.from({ length: 100 }, (_, t) => ({
      date: addDays(start, t),
      total: 50,
      aht: 300,
    }))
    const futureDates = [addDays(start, 100), addDays(start, 101)]
    const out = forecastDhr({
      train,
      trainHolidays: new Set(),
      futureDates,
      futureHolidays: new Set([futureDates[1]]),
    })
    expect(out[0]).toBeGreaterThanOrEqual(0)
    expect(out[1]).toBe(0)
  })
})

describe('calendar holidays on open queues', () => {
  it('learns a holiday lift when calendarHolidays marks open holidays', () => {
    // 280 days, base 1000, every 28th day is a "holiday" with +50% volume.
    const start = '2024-01-01'
    const train: DailyPoint[] = []
    const calendarHolidays = new Set<string>()
    for (let i = 0; i < 280; i++) {
      const date = addDays(start, i)
      const holiday = i % 28 === 14
      if (holiday) calendarHolidays.add(date)
      train.push({ date, total: holiday ? 1500 : 1000, aht: 300 })
    }
    const futureDates = Array.from({ length: 28 }, (_, j) => addDays(start, 280 + j))
    const futureHoliday = futureDates[14 - (280 % 28)] ?? futureDates[0]
    calendarHolidays.add(addDays(start, 280 + 14 - (280 % 28)))

    const base: Omit<ForecastInput, 'calendarHolidays'> = {
      train,
      trainHolidays: new Set(),
      futureDates,
      futureHolidays: new Set(),
    }
    const withCal = forecastDhr({ ...base, calendarHolidays })
    const without = forecastDhr(base)

    const idx = futureDates.indexOf(futureHoliday)
    // With the calendar covariate the holiday day forecasts materially higher.
    expect(withCal[idx]).toBeGreaterThan(without[idx] + 200)
    expect(withCal[idx]).toBeGreaterThan(1300)
  })
})
