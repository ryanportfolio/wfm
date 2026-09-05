import { describe, expect, it } from 'vitest'
import { analyzeDataQuality } from './dataQuality'
import type { IntervalRecord } from './types'

function row(date: string, time = '08:00', offered = 10, queue = 'q'): IntervalRecord {
  return { ts: `${date}T${time}`, queue, offered, aht: offered ? 300 : 0 }
}

describe('data completeness', () => {
  it.each(['0000', '0001', '0099', '0999', '2026'])('preserves four-digit year %s in missing-date samples', (year) => {
    const [report] = analyzeDataQuality([row(`${year}-01-01`), row(`${year}-01-03`)])
    expect(report.missingDates).toEqual({ count: 1, samples: [`${year}-01-02`] })
  })

  it('separates absent dates, one missing Monday slot and recorded zero demand', () => {
    const records = [row('2026-01-05'), row('2026-01-05', '08:30'),
      row('2026-01-12', '08:00', 0), row('2026-01-19'), row('2026-01-19', '08:30:00')]
    const [report] = analyzeDataQuality(records)
    expect(report.missingDates.count).toBe(12)
    expect(report.missingDates.samples).toEqual(['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'])
    expect(report.missingSlots).toEqual({ count: 1, samples: ['2026-01-12T08:30:00'] })
    expect(report.zeroRows).toBe(1)
    expect(analyzeDataQuality([...records].reverse())).toEqual([report])
    expect(records.reduce((sum, r) => sum + r.offered, 0)).toBe(40)
  })

  it('does not infer from single observations, another weekday, or another queue', () => {
    const reports = analyzeDataQuality([
      row('2026-01-05'), row('2026-01-05', '08:30'), row('2026-01-12'),
      row('2026-01-06', '09:00'), row('2026-01-13', '09:00'),
      row('2026-01-05', '10:00', 1, 'other'), row('2026-01-12', '10:00', 1, 'other'),
    ])
    expect(reports.find((r) => r.queue === 'q')?.missingSlots.count).toBe(0)
    expect(reports.find((r) => r.queue === 'other')?.missingDates.count).toBe(6)
  })

  it('does not treat a slot seen on only half of observed weekdays as expected', () => {
    const records = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'].map((d) => row(d))
    records.push(row('2026-01-05', '08:30'), row('2026-01-12', '08:30'))
    expect(analyzeDataQuality(records)[0].missingSlots.count).toBe(0)
  })

  it('counts long missing spans without producing a full gap list', () => {
    const [report] = analyzeDataQuality([row('2000-01-01'), row('2400-01-01')])
    // A Gregorian 400-year cycle has 146097 days; endpoints are observed.
    expect(report.missingDates.count).toBe(146096)
    expect(report.missingDates.samples).toHaveLength(5)
    expect(report.missingSlots.count).toBe(0)
  })

  it('bounds slot examples while keeping the full count', () => {
    const dates = ['2026-01-05', '2026-01-12', '2026-01-19']
    const records = dates.map((d) => row(d))
    for (const date of [dates[0], dates[2]]) {
      for (const time of ['08:30', '09:00', '09:30', '10:00', '10:30', '11:00']) records.push(row(date, time))
    }
    const [report] = analyzeDataQuality(records)
    expect(report.missingSlots.count).toBe(6)
    expect(report.missingSlots.samples).toHaveLength(5)
  })

  it('handles empty and zero-only history without inventing demand or gaps', () => {
    expect(analyzeDataQuality([])).toEqual([])
    const [report] = analyzeDataQuality([row('2026-01-05', '08:00', 0)])
    expect(report).toEqual({ queue: 'q', zeroRows: 1,
      missingDates: { count: 0, samples: [] }, missingSlots: { count: 0, samples: [] } })
  })
})
