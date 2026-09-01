import { describe, expect, it } from 'vitest'
import { generateSampleData, SAMPLE_START, SAMPLE_END, SAMPLE_QUEUES } from './sampleData'
import { usHolidays } from './holidays'

const data = generateSampleData()

describe('generateSampleData', () => {
  it('is deterministic across calls', () => {
    const again = generateSampleData()
    expect(again.length).toBe(data.length)
    for (let i = 0; i < data.length; i++) {
      const a = data[i]
      const b = again[i]
      if (a.ts !== b.ts || a.queue !== b.queue || a.offered !== b.offered || a.aht !== b.aht) {
        expect.fail(`record ${i} differs: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
      }
    }
  })

  it('covers 2 years x 48 intervals x 3 queues', () => {
    expect(data.length).toBe(730 * 48 * 3)
    const queues = new Set(data.map((r) => r.queue))
    expect([...queues].sort()).toEqual([...SAMPLE_QUEUES].sort())
  })

  it('has zero volume on US federal holidays', () => {
    const holidays = new Set(usHolidays(SAMPLE_START, SAMPLE_END))
    expect(holidays.size).toBeGreaterThan(20)
    for (const r of data) {
      if (holidays.has(r.ts.slice(0, 10))) {
        expect(r.offered).toBe(0)
        expect(r.aht).toBe(0)
      }
    }
  })

  it('has zero volume outside 08:00-20:00', () => {
    for (const r of data) {
      const hour = Number(r.ts.slice(11, 13))
      if (hour < 8 || hour >= 20) {
        expect(r.offered).toBe(0)
      }
    }
  })

  it('has volume during open hours on regular days', () => {
    const holidays = new Set(usHolidays(SAMPLE_START, SAMPLE_END))
    const open = data.filter((r) => {
      const hour = Number(r.ts.slice(11, 13))
      return hour >= 8 && hour < 20 && !holidays.has(r.ts.slice(0, 10))
    })
    const nonZero = open.filter((r) => r.offered > 0)
    expect(nonZero.length / open.length).toBeGreaterThan(0.95)
    for (const r of nonZero) {
      expect(r.aht).toBeGreaterThan(0)
    }
  })

  it('is overdispersed: variance exceeds mean in a weekday/interval cell', () => {
    const cell = data.filter(
      (r) => r.queue === 'voice-benefits' && r.ts.endsWith('T10:00:00') && r.offered > 0,
    )
    const mondays = cell.filter((r) => {
      // 2024-08-19 was a Monday; day-number mod 7 identifies weekday without Date
      const days = Math.round(Date.parse(r.ts.slice(0, 10) + 'T00:00:00Z') / 86400000)
      return ((days % 7) + 11) % 7 === 1
    })
    expect(mondays.length).toBeGreaterThan(80)
    const values = mondays.map((r) => r.offered)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
    expect(variance).toBeGreaterThan(mean)
  })
})

describe('usHolidays', () => {
  it('returns known holidays with observed shifts', () => {
    const holidays = usHolidays('2026-01-01', '2026-12-31')
    expect(holidays).toContain('2026-01-01')
    expect(holidays).toContain('2026-01-19') // MLK Day, 3rd Monday
    expect(holidays).toContain('2026-07-03') // July 4 2026 is a Saturday, observed Friday
    expect(holidays).toContain('2026-07-04')
    expect(holidays).toContain('2026-11-26') // Thanksgiving, 4th Thursday
    expect(holidays).toContain('2026-12-25')
  })

  it('filters to the requested range and sorts', () => {
    const holidays = usHolidays('2025-11-01', '2025-12-31')
    expect(holidays).toEqual(['2025-11-11', '2025-11-27', '2025-12-25'])
  })
})
