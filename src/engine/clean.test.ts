import { describe, expect, it } from 'vitest'
import type { IntervalRecord } from './types'
import { addDays } from './series'
import { cleanQueue } from './clean'

const TIMES = ['09:00', '09:30', '10:00', '10:30']

/**
 * 85 contiguous days from Monday 2025-03-03 through Memorial Day 2025-05-26.
 * Every interval offers 100 + weekIdx % 3 (so cell MAD > 0), except an
 * injected outlier and the zero-volume holiday on the last day.
 */
function buildRecords(withOutlier: boolean): IntervalRecord[] {
  const records: IntervalRecord[] = []
  for (let i = 0; i < 85; i++) {
    const date = addDays('2025-03-03', i)
    const holiday = date === '2025-05-26'
    for (const time of TIMES) {
      let offered = holiday ? 0 : 100 + (Math.floor(i / 7) % 3)
      if (withOutlier && date === '2025-04-01' && time === '09:30') offered = 1000
      records.push({ ts: `${date}T${time}`, queue: 'q', offered, aht: offered > 0 ? 300 : 0 })
    }
  }
  return records
}

describe('cleanQueue', () => {
  it('flags the injected outlier and nothing else', () => {
    const result = cleanQueue(buildRecords(true), 'q')
    expect(result.report.flaggedIntervals).toHaveLength(1)
    const flag = result.report.flaggedIntervals[0]
    expect(flag.date).toBe('2025-04-01')
    expect(flag.time).toBe('09:30:00')
    expect(flag.original).toBe(1000)
    expect(flag.replacement).toBe(101)
    expect(result.report.flaggedDays).toHaveLength(0)
  })

  it('replaces the flagged cell so the day total is rebuilt', () => {
    const result = cleanQueue(buildRecords(true), 'q')
    const day = result.daily.find((p) => p.date === '2025-04-01')!
    expect(day.total).toBe(404) // 4 intervals x 101
  })

  it('flags nothing on clean data', () => {
    const result = cleanQueue(buildRecords(false), 'q')
    expect(result.report.flaggedIntervals).toHaveLength(0)
    expect(result.report.flaggedDays).toHaveLength(0)
  })

  it('tracks zero-volume holidays separately and excludes them from fitting', () => {
    const result = cleanQueue(buildRecords(false), 'q')
    expect(result.report.closedHolidays).toEqual(['2025-05-26'])
    expect(result.report.holidayClosed).toBe(true)
    // The holiday day keeps its zero total and is never flagged.
    const holiday = result.daily.find((p) => p.date === '2025-05-26')!
    expect(holiday.total).toBe(0)
  })

  it('flags a whole-day outlier at the daily level when cells stay in range', () => {
    // Two anti-correlated intervals: cell values swing +-10 by week
    // (cell MAD 5, limit ~25.9) while daily totals only vary 210/212/214
    // (daily MAD 2, limit ~10.4). A +8 shift on both intervals stays inside
    // every cell limit but pushes the day total 18 above the daily median.
    const records: IntervalRecord[] = []
    for (let i = 0; i < 84; i++) {
      const date = addDays('2025-03-03', i)
      const week = Math.floor(i / 7)
      let a = 100 + 10 * (week % 2) + (week % 3)
      let b = 110 - 10 * (week % 2) + (week % 3)
      if (date === '2025-04-08') {
        a += 8
        b += 8
      }
      records.push({ ts: `${date}T09:00`, queue: 'q', offered: a, aht: 300 })
      records.push({ ts: `${date}T09:30`, queue: 'q', offered: b, aht: 300 })
    }
    const result = cleanQueue(records, 'q')
    expect(result.report.flaggedIntervals).toHaveLength(0)
    expect(result.report.flaggedDays).toHaveLength(1)
    expect(result.report.flaggedDays[0].date).toBe('2025-04-08')
    expect(result.report.flaggedDays[0].original).toBe(230)
    expect(result.report.flaggedDays[0].replacement).toBe(212)
    expect(result.daily.find((p) => p.date === '2025-04-08')!.total).toBe(212)
  })
})
