import { describe, expect, it } from 'vitest'
import type { IntervalRecord } from './types'
import { addDays, groupQueueDays } from './series'
import { buildProfiles, intervalize } from './profiles'

const TIMES = ['09:00', '09:30', '10:00', '10:30']

/** 8 weeks, volume shaped by weekday and time slot, constant AHT 300. */
function buildRecords(): IntervalRecord[] {
  const records: IntervalRecord[] = []
  for (let i = 0; i < 56; i++) {
    const date = addDays('2025-01-05', i) // starts on a Sunday
    for (let t = 0; t < TIMES.length; t++) {
      const offered = (10 + 5 * t) * (1 + (i % 7)) // varies by slot and weekday
      records.push({ ts: `${date}T${TIMES[t]}`, queue: 'q', offered, aht: 300 })
    }
  }
  return records
}

describe('buildProfiles', () => {
  const days = groupQueueDays(buildRecords(), 'q')
  const profiles = buildProfiles(days, new Set())

  it('produces shares summing to 1 for every weekday', () => {
    for (let wd = 0; wd < 7; wd++) {
      const sum = profiles.shares[wd].reduce((a, v) => a + v, 0)
      expect(sum).toBeCloseTo(1, 10)
    }
  })

  it('reflects the intraday shape', () => {
    // Slot weights 10/15/20/25 regardless of weekday.
    for (let wd = 0; wd < 7; wd++) {
      expect(profiles.shares[wd][0]).toBeCloseTo(10 / 70, 10)
      expect(profiles.shares[wd][3]).toBeCloseTo(25 / 70, 10)
    }
  })

  it('forecasts the constant AHT', () => {
    for (let wd = 0; wd < 7; wd++) {
      for (let t = 0; t < TIMES.length; t++) {
        expect(profiles.ahtByCell[wd][t]).toBeCloseTo(300, 10)
      }
    }
  })

  it('excludes excluded dates from the profile', () => {
    // Give one Sunday a wildly different shape; excluding it must restore
    // the clean shares.
    const skewed = buildRecords().map((r) =>
      r.ts.startsWith('2025-02-16T09:00') ? { ...r, offered: 100000 } : r,
    )
    const withSkew = buildProfiles(groupQueueDays(skewed, 'q'), new Set())
    const without = buildProfiles(groupQueueDays(skewed, 'q'), new Set(['2025-02-16']))
    expect(withSkew.shares[0][0]).toBeGreaterThan(0.5)
    expect(without.shares[0][0]).toBeCloseTo(10 / 70, 10)
  })
})

describe('intervalize', () => {
  it('conserves each daily total', () => {
    const profiles = buildProfiles(groupQueueDays(buildRecords(), 'q'), new Set())
    const daily = [
      { date: '2025-03-03', total: 500, aht: 0 },
      { date: '2025-03-04', total: 123.45, aht: 0 },
    ]
    const points = intervalize(daily, profiles)
    expect(points).toHaveLength(2 * TIMES.length)
    for (const day of daily) {
      const sum = points.filter((p) => p.ts.startsWith(day.date)).reduce((a, p) => a + p.offered, 0)
      expect(sum).toBeCloseTo(day.total, 9)
    }
  })
})
