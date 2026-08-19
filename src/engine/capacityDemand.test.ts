import { describe, expect, it } from 'vitest'
import type { IntervalRecord } from './types'
import type { CapacityAssumptions } from './capacityTypes'
import type { StaffingConfig } from './staffing'
import { addDays, dayNumFromIso, isoFromDayNum, weekdayOfIso } from './series'
import { generateSampleData, usHolidays, SAMPLE_END } from './sampleData'
import {
  isoWeekOf,
  planWeeks,
  projectedServiceLevel,
  seedAht,
  seedWeeklyBaseline,
  weeklyDemand,
} from './capacityDemand'

function makeStaffing(overrides: Partial<StaffingConfig> = {}): StaffingConfig {
  return {
    mode: 'erlangC',
    slPct: 0.8,
    slSeconds: 20,
    patienceSec: 180,
    shrinkage: 0,
    intervalSec: 1800,
    ...overrides,
  }
}

function makeAssumptions(overrides: Partial<CapacityAssumptions> = {}): CapacityAssumptions {
  return {
    queue: 'q',
    weeks: 1,
    paidHoursPerWeek: 40,
    growthWeeklyPct: 0,
    volumeOverrides: new Map(),
    ahtOverrides: new Map(),
    shrinkageByWeek: new Map(),
    defaultShrinkage: 0.2,
    attritionAnnualPct: 0.3,
    trainingAttritionPct: 0.1,
    startingProductionHc: 0,
    rampWeeks: 8,
    hireClasses: [],
    staffing: makeStaffing(),
    ...overrides,
  }
}

describe('isoWeekOf', () => {
  it('matches known ISO week facts', () => {
    expect(isoWeekOf('2026-01-01')).toBe(1) // Thursday, so week 1 of 2026
    expect(isoWeekOf('2024-12-30')).toBe(1) // Monday of week 1 of ISO 2025
    expect(isoWeekOf('2026-12-28')).toBe(53) // ISO 2026 has 53 weeks
    expect(isoWeekOf('2025-03-10')).toBe(11)
  })
})

describe('planWeeks', () => {
  it('starts the first Monday after a Sunday history end', () => {
    // 2026-08-16 is a Sunday.
    expect(planWeeks('2026-08-16', 3)).toEqual(['2026-08-17', '2026-08-24', '2026-08-31'])
  })

  it('starts the following Monday after a mid-week history end', () => {
    // 2025-03-05 is a Wednesday.
    expect(planWeeks('2025-03-05', 2)).toEqual(['2025-03-10', '2025-03-17'])
  })

  it('is strictly after a Monday history end', () => {
    // 2025-03-03 is itself a Monday.
    expect(planWeeks('2025-03-03', 1)).toEqual(['2025-03-10'])
  })

  it('returns only Mondays, 7 days apart', () => {
    const weeks = planWeeks('2026-08-16', 52)
    expect(weeks).toHaveLength(52)
    for (let i = 0; i < weeks.length; i++) {
      expect(weekdayOfIso(weeks[i])).toBe(1)
      if (i > 0) expect(dayNumFromIso(weeks[i]) - dayNumFromIso(weeks[i - 1])).toBe(7)
    }
  })
})

/**
 * Two full ISO years of daily history (2023-01-02 Monday .. 2024-12-29
 * Sunday, 104 complete weeks), one interval per day. Offered 10/day except
 * ISO week 11: 30/day in 2023, 60/day in 2024. Constant values keep MAD = 0,
 * so the cleaner flags nothing and the arithmetic stays hand-checkable.
 */
function twoYearRecords(): IntervalRecord[] {
  const records: IntervalRecord[] = []
  const spike2023 = new Set(['2023-03-13', '2023-03-14', '2023-03-15', '2023-03-16', '2023-03-17', '2023-03-18', '2023-03-19'])
  const spike2024 = new Set(['2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15', '2024-03-16', '2024-03-17'])
  for (let i = 0; i < 728; i++) {
    const date = addDays('2023-01-02', i)
    const offered = spike2023.has(date) ? 30 : spike2024.has(date) ? 60 : 10
    records.push({ ts: `${date}T12:00:00`, queue: 'q', offered, aht: 300 })
  }
  return records
}

describe('seedWeeklyBaseline', () => {
  const baseline = seedWeeklyBaseline(twoYearRecords(), 'q', [
    '2025-03-10', // ISO week 11: the spiked week
    '2025-03-17', // ISO week 12: plain
    '2026-12-28', // ISO week 53: absent from history, falls back
  ])

  it('weights the recent year 2x on the same ISO week', () => {
    // Week 11 totals: 7*30 = 210 (2023), 7*60 = 420 (2024), no holidays in
    // either week. Weighted average = (1*210 + 2*420) / 3 = 350; the
    // unweighted mean would be 315.
    expect(baseline.get('2025-03-10')).toBeCloseTo(350, 9)
  })

  it('averages plain weeks to the plain total', () => {
    // Week 12 totals 70 in both years: (1*70 + 2*70) / 3 = 70.
    expect(baseline.get('2025-03-17')).toBeCloseTo(70, 9)
  })

  it('falls back to the overall weekly mean for a missing ISO week', () => {
    // ISO week 53 never occurs in 2023/2024. Expected fallback: mean of all
    // 104 complete weekly totals of non-holiday daily volume, recomputed
    // independently here.
    const holidays = new Set(usHolidays('2023-01-02', '2024-12-29'))
    const spikes = new Map<string, number>()
    for (const r of twoYearRecords()) spikes.set(r.ts.slice(0, 10), r.offered)
    let sum = 0
    let count = 0
    for (let m = dayNumFromIso('2023-01-02'); m + 6 <= dayNumFromIso('2024-12-29'); m += 7) {
      let weekTotal = 0
      for (let d = 0; d < 7; d++) {
        const date = isoFromDayNum(m + d)
        if (!holidays.has(date)) weekTotal += spikes.get(date)!
      }
      sum += weekTotal
      count++
    }
    expect(count).toBe(104)
    expect(baseline.get('2026-12-28')).toBeCloseTo(sum / count, 9)
  })
})

describe('seedAht', () => {
  it('volume-weights AHT over the trailing 8 weeks only', () => {
    // 140 days; the first 84 have aht 300 (outside the window), the last 56
    // alternate offered 10 @ aht 400 and offered 30 @ aht 200:
    // (28*10*400 + 28*30*200) / (28*10 + 28*30) = 250.
    const records: IntervalRecord[] = []
    for (let i = 0; i < 140; i++) {
      const date = addDays('2025-01-06', i)
      const inWindow = i >= 84
      const offered = inWindow ? (i % 2 === 0 ? 10 : 30) : 10
      const aht = inWindow ? (i % 2 === 0 ? 400 : 200) : 300
      records.push({ ts: `${date}T12:00:00`, queue: 'q', offered, aht })
    }
    expect(seedAht(records, 'q')).toBeCloseTo(250, 9)
  })
})

/**
 * Tiny hand-checkable history: 4 Mondays (2025-06-02..23), two intervals
 * each: 09:00 offered 30, 09:30 offered 10, aht 360. All other days have no
 * records (zero-filled by grouping), so the Monday day-of-week share is 1 and
 * the intraday shares are 0.75 / 0.25. Baseline for any plan week falls back
 * to the overall weekly mean, 40. Seed AHT = 360.
 */
function mondayRecords(): IntervalRecord[] {
  const records: IntervalRecord[] = []
  for (const date of ['2025-06-02', '2025-06-09', '2025-06-16', '2025-06-23']) {
    records.push({ ts: `${date}T09:00:00`, queue: 'q', offered: 30, aht: 360 })
    records.push({ ts: `${date}T09:30:00`, queue: 'q', offered: 10, aht: 360 })
  }
  return records
}

describe('weeklyDemand', () => {
  it('compounds growth per week index', () => {
    const weeks = planWeeks('2025-06-23', 3)
    const demand = weeklyDemand(mondayRecords(), 'q', makeAssumptions({ growthWeeklyPct: 0.1 }), weeks)
    expect(demand.map((w) => w.volume)).toEqual([
      40,
      expect.closeTo(44, 9),
      expect.closeTo(48.4, 9),
    ])
  })

  it('lets overrides beat baseline, growth, and seed AHT', () => {
    const weeks = planWeeks('2025-06-23', 3) // 2025-06-30, 07-07, 07-14
    const assumptions = makeAssumptions({
      growthWeeklyPct: 0.1,
      volumeOverrides: new Map([['2025-07-07', 100]]),
      ahtOverrides: new Map([['2025-06-30', 500]]),
    })
    const demand = weeklyDemand(mondayRecords(), 'q', assumptions, weeks)
    // Override is used verbatim: growth is not applied on top of it.
    expect(demand[1].volume).toBe(100)
    expect(demand[0].volume).toBeCloseTo(40, 9)
    expect(demand[2].volume).toBeCloseTo(48.4, 9)
    expect(demand[0].aht).toBe(500)
    expect(demand[1].aht).toBeCloseTo(360, 9)
  })

  it('computes requiredFte matching a direct hand computation', () => {
    // Week volume 40, all on Monday, split 30 / 10 across the two intervals,
    // aht 360, interval 1800s. Erlang C, 80% in 20s:
    //   A1 = 30*360/1800 = 6 erlangs -> min N = 9 (SL 0.8341)
    //   A2 = 10*360/1800 = 2 erlangs -> min N = 4 (SL 0.8444)
    // Scheduled = (9+4)/(1-0.2) = 16.25 agent-intervals * 0.5h = 8.125 h.
    // requiredFte = 8.125 / 40 = 0.203125.
    const weeks = planWeeks('2025-06-23', 1)
    const demand = weeklyDemand(mondayRecords(), 'q', makeAssumptions(), weeks)
    expect(demand).toHaveLength(1)
    const dw = demand[0]
    expect(dw.week).toBe('2025-06-30')
    expect(dw.volume).toBeCloseTo(40, 9)
    expect(dw.aht).toBeCloseTo(360, 9)
    expect(dw.requiredFte).toBeCloseTo(0.203125, 9)

    // The reusable interval forecast: 7 days x 2 times, volume conserved,
    // all of it on Monday 2025-06-30.
    expect(dw.intervals).toHaveLength(14)
    const total = dw.intervals.reduce((a, p) => a + p.offered, 0)
    expect(total).toBeCloseTo(40, 9)
    const monday = dw.intervals.filter((p) => p.ts.startsWith('2025-06-30'))
    expect(monday.map((p) => p.offered)).toEqual([expect.closeTo(30, 9), expect.closeTo(10, 9)])
    for (const p of dw.intervals) expect(p.aht).toBeCloseTo(360, 9)
  })

  it('uses the per-week shrinkage over the default and the config value', () => {
    const weeks = planWeeks('2025-06-23', 1)
    const assumptions = makeAssumptions({
      shrinkageByWeek: new Map([['2025-06-30', 0.5]]),
      staffing: makeStaffing({ shrinkage: 0.9 }), // must be ignored
    })
    const demand = weeklyDemand(mondayRecords(), 'q', assumptions, weeks)
    // (9+4)/(1-0.5) * 0.5h / 40 = 0.325
    expect(demand[0].requiredFte).toBeCloseTo(0.325, 9)
  })
})

describe('projectedServiceLevel', () => {
  const staffing = makeStaffing({ mode: 'erlangA' })
  const assumptions = makeAssumptions({ staffing })
  const weeks = planWeeks('2025-06-23', 1)
  const dw = weeklyDemand(mondayRecords(), 'q', assumptions, weeks)[0]
  const at = (fte: number): number =>
    projectedServiceLevel(dw.intervals, fte, 0.2, staffing, 40)

  it('meets the target when supply equals the requirement', () => {
    expect(at(dw.requiredFte)).toBeGreaterThanOrEqual(0.8)
  })

  it('drops materially at half supply', () => {
    const full = at(dw.requiredFte)
    const half = at(dw.requiredFte / 2)
    expect(half).toBeLessThan(full - 0.15)
    expect(half).toBeLessThan(0.8)
  })

  it('is monotone in supply', () => {
    const s1 = at(dw.requiredFte * 0.5)
    const s2 = at(dw.requiredFte * 0.75)
    const s3 = at(dw.requiredFte)
    expect(s1).toBeLessThanOrEqual(s2)
    expect(s2).toBeLessThanOrEqual(s3)
    expect(s1).toBeLessThan(s3)
  })

  it('is 0 with no supply and 1 with no volume', () => {
    expect(at(0)).toBe(0)
    const silent = dw.intervals.map((p) => ({ ...p, offered: 0 }))
    expect(projectedServiceLevel(silent, 1, 0.2, staffing, 40)).toBe(1)
  })
})

describe('performance', () => {
  it('runs a 52-week Erlang A demand plan on sample voice-benefits in < 1s', () => {
    const records = generateSampleData()
    const weeks = planWeeks(SAMPLE_END, 52)
    const assumptions = makeAssumptions({
      queue: 'voice-benefits',
      weeks: 52,
      growthWeeklyPct: 0.002,
      defaultShrinkage: 0.3,
      staffing: makeStaffing({ mode: 'erlangA', occupancyCap: 0.9 }),
    })
    const t0 = performance.now()
    const demand = weeklyDemand(records, 'voice-benefits', assumptions, weeks)
    const ms = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`52-week voice-benefits demand: ${ms.toFixed(0)} ms`)
    expect(demand).toHaveLength(52)
    for (const w of demand) {
      expect(w.intervals).toHaveLength(336)
      expect(w.volume).toBeGreaterThan(0)
      expect(w.requiredFte).toBeGreaterThan(0)
      expect(Number.isFinite(w.requiredFte)).toBe(true)
    }
    expect(ms).toBeLessThan(1000)
  })
})
