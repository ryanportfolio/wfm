import { describe, expect, it } from 'vitest'
import { buildHistorySeed, firstPlanMonday, isoWeekOf, seedDemandFromHistory, weeklyRequirementHours } from './capacitySeed'
import { addDays } from './series'
import { applyScenario } from './staffing'
import type { IntervalRecord } from './types'

function history(from: string, to: string, times: string[], value: (date: string, time: string) => { offered: number; aht: number }): IntervalRecord[] {
  const out: IntervalRecord[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) for (const t of times) out.push({ ts: `${d}T${t}`, queue: 'voice', ...value(d, t) })
  return out
}
// Volume identifies its ISO year and week; AHT identifies the year.
const byWeek = (date: string, time: string) => {
  const { isoYear, isoWeek } = isoWeekOf(date)
  return { offered: (10 + isoWeek + 100 * (isoYear - 2023)) * (time === '08:30' ? 2 : 1), aht: isoYear === 2023 ? 300 : 200 }
}
const config = { mode: 'erlangA' as const, slPct: 0.8, slSeconds: 20, patienceSec: 120, shrinkage: 0.3, intervalSec: 1800, queue: 'voice' }

describe('ISO week helpers', () => {
  it('numbers ISO weeks across year boundaries and finds the first plan Monday', () => {
    expect(isoWeekOf('2026-01-01')).toEqual({ isoYear: 2026, isoWeek: 1 })
    expect(isoWeekOf('2027-01-01')).toEqual({ isoYear: 2026, isoWeek: 53 })
    expect(isoWeekOf('2024-12-30')).toEqual({ isoYear: 2025, isoWeek: 1 })
    expect(isoWeekOf('2025-03-17')).toEqual({ isoYear: 2025, isoWeek: 12 })
    const records = history('2025-03-10', '2025-03-16', ['08:00'], () => ({ offered: 1, aht: 60 }))
    expect(firstPlanMonday(records, 'voice')).toBe('2025-03-17')
    expect(firstPlanMonday([...records, { ts: '2025-03-17T08:00', queue: 'voice', offered: 1, aht: 60 }], 'voice')).toBe('2025-03-24')
    expect(() => firstPlanMonday(records, 'chat')).toThrow('No history')
  })
})

describe('buildHistorySeed', () => {
  const records = history('2023-01-02', '2025-03-16', ['08:00', '08:30'], byWeek)

  it('averages the same ISO week with doubling year weights and growth by distance to each plan week', () => {
    const g = 0.01
    const seed = buildHistorySeed(records, 'voice', '2025-03-17', g)
    expect(seed.weeks.map(w => w.isoWeek)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
    const first = seed.weeks[0]
    expect(first.source).toBe('sameIsoWeek')
    expect(first.contributors.map(c => [c.start, c.weight, c.weeksBefore])).toEqual([['2023-03-20', 1 / 3, 104], ['2024-03-18', 2 / 3, 52]])
    const o2023 = 10 + 12, o2024 = 10 + 12 + 100
    const grown2023 = o2023 * 1.01 ** 104 / 3, grown2024 = o2024 * 1.01 ** 52 * 2 / 3
    const [monday800, monday830] = seed.intervalForecast.slice(0, 2)
    expect(monday800.ts).toBe('2025-03-17T08:00:00')
    expect(monday800.offered).toBeCloseTo(grown2023 + grown2024, 10)
    expect(monday830.offered).toBeCloseTo(2 * (grown2023 + grown2024), 10)
    expect(monday800.aht).toBeCloseTo((grown2023 * 300 + grown2024 * 200) / (grown2023 + grown2024), 10)
    // Week 13 averages its own ISO week, again about one and two years back.
    const last = seed.weeks[12]
    expect(last.contributors.map(c => c.weeksBefore)).toEqual([104, 52])
    const lastOffered = seed.intervalForecast.find(p => p.ts === `${last.start}T08:00:00`)!.offered
    expect(lastOffered).toBeCloseTo((10 + 24) * 1.01 ** 104 / 3 + (110 + 24) * 1.01 ** 52 * 2 / 3, 10)
    expect(seed.intervalForecast).toHaveLength(13 * 7 * 2)
    expect(seed.intervalForecast.at(-1)!.ts).toBe(`${addDays('2025-03-17', 90)}T08:30:00`)
  })

  it('keeps holiday weeks in their ISO week and flags whether history and plan weeks hold a holiday', () => {
    const seed = buildHistorySeed(records, 'voice', '2025-03-17', 0)
    // ISO week 22 holds Memorial Day in 2023, 2024 and the 2025 plan week.
    const memorial = seed.weeks[10]
    expect(memorial).toMatchObject({ isoWeek: 22, start: '2025-05-26', source: 'sameIsoWeek', holidayInHistory: true, holidayInPlan: true })
    expect(memorial.contributors.map(c => [c.start, c.weight, c.holiday])).toEqual([['2023-05-29', 1 / 3, true], ['2024-05-27', 2 / 3, true]])
    expect(seed.intervalForecast.find(p => p.ts === '2025-05-26T08:00:00')!.offered).toBeCloseTo((10 + 22) / 3 + (110 + 22) * 2 / 3, 10)
    expect(seed.weeks[0]).toMatchObject({ holidayInHistory: false, holidayInPlan: false })
    expect(seed.weeks.every(w => w.source === 'sameIsoWeek')).toBe(true)
  })

  it('flags a holiday mismatch when only a history week holds the holiday', () => {
    // Veterans Day 2023 fell on Saturday, observed Friday, in ISO week 45; in 2024 and 2025 it falls in week 46.
    const long = history('2023-01-02', '2025-09-14', ['08:00'], byWeek)
    const seed = buildHistorySeed(long, 'voice', '2025-09-15', 0)
    const week45 = seed.weeks.find(w => w.isoWeek === 45)!
    expect(week45).toMatchObject({ start: '2025-11-03', holidayInHistory: true, holidayInPlan: false })
    expect(week45.contributors.map(c => [c.start, c.holiday])).toEqual([['2023-11-06', true], ['2024-11-04', false]])
    expect(seed.weeks.find(w => w.isoWeek === 46)).toMatchObject({ holidayInHistory: true, holidayInPlan: true })
    // Thanksgiving: week 47 in 2023, week 48 in 2024 and 2025.
    expect(seed.weeks.find(w => w.isoWeek === 47)).toMatchObject({ holidayInHistory: true, holidayInPlan: false })
    expect(seed.weeks.find(w => w.isoWeek === 48)).toMatchObject({ holidayInHistory: true, holidayInPlan: true })
    expect(seed.weeks.find(w => w.isoWeek === 44)).toMatchObject({ holidayInHistory: false, holidayInPlan: false })
  })

  it('falls back to the mean of every prior week only for an ISO week absent from history', () => {
    // 2025 has 52 ISO weeks; the plan's 13th week is 2026 week 53.
    // A gentle trend keeps every value inside the outlier-cleaning limits.
    const trend = (date: string) => ({ offered: 100 + isoWeekOf(date).isoWeek, aht: 200 })
    const year = history('2025-09-29', '2026-09-27', ['08:00'], trend)
    const seed = buildHistorySeed(year, 'voice', '2026-10-05', 0.01)
    expect(seed.weeks.map(w => w.source)).toEqual([...Array(12).fill('sameIsoWeek'), 'allWeeksMean'])
    const week53 = seed.weeks[12]
    expect(week53).toMatchObject({ isoYear: 2026, isoWeek: 53, start: '2026-12-28', holidayInHistory: false, holidayInPlan: true })
    // Contributors still record their own holidays; only the week-level flag ignores fallback history.
    expect(week53.contributors.some(c => c.holiday)).toBe(true)
    expect(week53.contributors).toHaveLength(52)
    expect(week53.contributors.every(c => c.weight === 1 / 52)).toBe(true)
    const expected = week53.contributors.reduce((sum, c) => sum + trend(c.start).offered * 1.01 ** c.weeksBefore, 0) / 52
    expect(seed.intervalForecast.find(p => p.ts === '2026-12-28T08:00:00')!.offered).toBeCloseTo(expected, 10)
    expect(week53.contributors[0].weeksBefore).toBe(65)
  })

  it('falls back for ISO weeks absent from short history, growing each week by its own distance', () => {
    const short = history('2025-01-06', '2025-03-16', ['08:00'], byWeek)
    const seed = buildHistorySeed(short, 'voice', '2025-03-17', 0.02)
    expect(seed.weeks.every(w => w.source === 'allWeeksMean')).toBe(true)
    // MLK Day (week 4) and Washington's Birthday (week 8) weeks stay in the mean.
    const weeks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    expect(seed.weeks[0].contributors.map(c => c.weeksBefore)).toEqual(weeks.map(w => 12 - w))
    expect(seed.weeks[0].contributors.filter(c => c.holiday).map(c => c.start)).toEqual(['2025-01-20', '2025-02-17'])
    expect(seed.weeks[0]).toMatchObject({ holidayInHistory: false, holidayInPlan: false })
    const expected = weeks.reduce((sum, w) => sum + (210 + w) * 1.02 ** (12 - w), 0) / weeks.length
    expect(seed.intervalForecast[0].offered).toBeCloseTo(expected, 10)
    expect(seed.weeks[1].contributors[0].weeksBefore).toBe(11)
  })

  it('counts absent dates inside the history range as zero volume', () => {
    const gap = history('2025-01-06', '2025-01-19', ['08:00'], byWeek).filter(r => !r.ts.startsWith('2025-01-15'))
    const seed = buildHistorySeed(gap, 'voice', '2025-01-20', 0)
    expect(seed.intervalForecast.filter(p => p.ts.slice(0, 10) === '2025-01-22')).toEqual([{ ts: '2025-01-22T08:00:00', offered: 212 / 2, aht: 200 }])
  })

  it('gives a cleaned interval that gained volume the cell AHT from history', () => {
    // A zero-volume Monday is an outlier its cell median replaces; its recorded AHT of 0 is not used as workload.
    const varied = (date: string) => ({ offered: 100 + 2 * (isoWeekOf(date).isoWeek % 3), aht: 300 })
    const gap = history('2025-01-06', '2025-03-16', ['08:00'], (d) => d === '2025-03-10' ? { offered: 0, aht: 0 } : varied(d))
    const seed = buildHistorySeed(gap, 'voice', '2025-03-17', 0)
    const monday = seed.intervalForecast[0]
    expect(monday.ts).toBe('2025-03-17T08:00:00')
    expect(monday.offered).toBeGreaterThan(100)
    expect(monday.aht).toBeCloseTo(300, 10)
  })

  it('ignores records on or after the plan start, so later data cannot change cleaning', () => {
    const before = history('2025-01-06', '2025-03-16', ['08:00'], byWeek)
    // Varied later volume would move the cell median and MAD enough to flag every earlier interval.
    const later = history('2025-03-17', '2025-06-29', ['08:00'], (d) => ({ offered: 1000 + (Number(d.slice(8, 10)) % 3), aht: 200 }))
    expect(buildHistorySeed([...before, ...later], 'voice', '2025-03-17', 0)).toEqual(buildHistorySeed(before, 'voice', '2025-03-17', 0))
  })

  it('uses only complete weeks that end before the plan start', () => {
    const seed = buildHistorySeed(records, 'voice', '2024-03-25', 0)
    expect(seed.weeks[0].isoWeek).toBe(13)
    expect(seed.weeks[0].contributors.map(c => c.start)).toEqual(['2023-03-27'])
    expect(seed.weeks.flatMap(w => w.contributors).every(c => c.weeksBefore >= 1)).toBe(true)
    // History starting midweek and ending midweek has no complete week.
    const partial = history('2025-03-12', '2025-03-18', ['08:00'], byWeek)
    expect(() => buildHistorySeed(partial, 'voice', '2025-03-24', 0)).toThrow('complete Monday-to-Sunday')
  })

  it('rejects an invalid plan start, growth outside 5% per week and unknown queues', () => {
    for (const start of ['2025-03-18', '2025-02-30', '2025-3-17', '']) expect(() => buildHistorySeed(records, 'voice', start, 0)).toThrow('Monday')
    for (const g of [0.051, -0.051, NaN, Infinity]) expect(() => buildHistorySeed(records, 'voice', '2025-03-17', g)).toThrow('growth')
    expect(() => buildHistorySeed(records, 'voice', '2025-03-17', 0.05)).not.toThrow()
    expect(() => buildHistorySeed(records, 'chat', '2025-03-17', 0)).toThrow('complete')
  })
})

describe('seedDemandFromHistory', () => {
  it('staffs the seeded intervals once and divides each plan week by paid hours', () => {
    const records = history('2024-01-01', '2025-03-16', ['08:00', '08:30'], byWeek)
    const result = seedDemandFromHistory(records, 'voice', { planStart: '2025-03-17', weeklyGrowth: 0.002, paidHoursPerWeek: 37.5, scenario: {}, config })
    const grid = applyScenario(result.seed.intervalForecast, {}, config)
    const hours = weeklyRequirementHours(grid.daily, '2025-03-17', 13)
    expect(result.requirementHours).toEqual(hours)
    expect(result.requiredProductiveFte).toEqual(hours.map(h => h / 37.5))
    expect(result.requiredProductiveFte.every(v => v > 0)).toBe(true)
    expect(() => seedDemandFromHistory(records, 'voice', { planStart: '2025-03-17', weeklyGrowth: 0, paidHoursPerWeek: 0, scenario: {}, config })).toThrow('Paid hours')
  })

  it('sums requirement hours by seven-day block from the start, ignoring days outside the plan', () => {
    const daily = ['2025-03-16', '2025-03-17', '2025-03-23', '2025-03-24', '2025-06-16'].map(date => ({ date, requiredFteHours: 8, scheduledFteHours: 99 }))
    expect(weeklyRequirementHours(daily, '2025-03-17', 13)).toEqual([16, 8, ...Array(11).fill(0)])
  })
})
