import { describe, expect, it } from 'vitest'
import { buildCapacityPlan, CAPACITY_LIMITS, validateCapacityConfig } from './capacity'
import type { CapacityConfig } from './capacity'

function demo(overrides: Partial<CapacityConfig> = {}): CapacityConfig {
  return {
    requiredProductiveFte: [78, 78, 78, 78, 78, 78, 84, 84, 84, 84, 84, 84, 84],
    startingHeadcount: 100, weeklyAttrition: 0, paidHoursPerWeek: 40,
    shrinkage: 0.2, hourlyCost: 25,
    hiringClass: { size: 10, startWeek: 2, trainingWeeks: 2, rampWeeks: 2 },
    ...overrides,
  }
}

describe('buildCapacityPlan', () => {
  it('matches the independent demo-oracle.md capacity, shortage and cost fixture', () => {
    const plan = buildCapacityPlan(demo())
    expect(plan.weeks.map(w => w.week)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(plan.weeks.map(w => w.baseline.productiveFte)).toEqual(Array(13).fill(80))
    expect(plan.weeks.map(w => w.scenario.productiveFte)).toEqual([80, 80, 80, 84, 88, 88, 88, 88, 88, 88, 88, 88, 88])
    expect(plan.weeks.map(w => w.incrementalCost)).toEqual([0, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000])
    expect(plan.baseline).toEqual({ firstShortageWeek: 7, totalCost: 1300000, totalShortageFteWeeks: 28 })
    expect(plan.scenario).toEqual({ firstShortageWeek: null, totalCost: 1420000, totalShortageFteWeeks: 0 })
    expect(plan.incrementalCost).toBe(120000)
    expect(plan.weeks[6].baseline.balanceFte).toBe(-4)
    expect(plan.weeks[6].scenario.surplusFte).toBe(4)
    expect(plan.weeks[1].scenario.paidHours).toBe(4400)
  })

  it('attrits existing and hired heads only after arrival, including during training and ramp', () => {
    const plan = buildCapacityPlan(demo({ weeklyAttrition: 0.1 }))
    expect(plan.weeks.slice(0, 3).map(w => w.baseline.existingHeadcount)).toEqual([100, 90, 81])
    expect(plan.weeks.slice(0, 4).map(w => w.scenario.hireHeadcount)).toEqual([0, 10, 9, 8.1])
    expect(plan.weeks[3].scenario.hireProductivity).toBe(0.5)
    expect(plan.weeks[3].incrementalProductiveFte).toBeCloseTo(3.24, 10)
    expect(plan.weeks[4].incrementalProductiveFte).toBeCloseTo(5.832, 10)
    expect(plan.weeks[2].scenario.cost).toBe(90000)
    expect(plan.weeks[3].incrementalCost).toBeCloseTo(8100, 8)
  })

  it('supports immediate productive hires and a week 13 arrival', () => {
    for (const startWeek of [1, 13]) {
      const plan = buildCapacityPlan(demo({ hiringClass: { size: 10, startWeek, trainingWeeks: 0, rampWeeks: 0 } }))
      expect(plan.weeks[startWeek - 1].scenario.productiveFte).toBe(88)
      expect(plan.weeks[startWeek - 1].incrementalCost).toBe(10000)
      if (startWeek === 13) {
        expect(plan.weeks[11].incrementalCost).toBe(0)
        expect(plan.incrementalCost).toBe(10000)
      }
    }
  })

  it('waits for full training weeks with zero ramp and allows training beyond the horizon', () => {
    const trained = buildCapacityPlan(demo({ hiringClass: { size: 10, startWeek: 1, trainingWeeks: 1, rampWeeks: 0 } }))
    expect(trained.weeks[0].scenario.productiveFte).toBe(80)
    expect(trained.weeks[1].scenario.productiveFte).toBe(88)
    const longTraining = buildCapacityPlan(demo({ hiringClass: { size: 10, startWeek: 1, trainingWeeks: 52, rampWeeks: 52 } }))
    expect(longTraining.weeks.every(w => w.incrementalProductiveFte === 0)).toBe(true)
    expect(longTraining.incrementalCost).toBe(130000)
  })

  it('uses a zero-size class as an exact disabled scenario', () => {
    const plan = buildCapacityPlan(demo({ hiringClass: { size: 0, startWeek: 13, trainingWeeks: 52, rampWeeks: 52 } }))
    expect(plan.baseline).toEqual(plan.scenario)
    for (const week of plan.weeks) expect(week.baseline).toEqual(week.scenario)
    expect(plan.incrementalCost).toBe(0)
  })

  it('handles total attrition, total shrinkage, zeros and zero-price hours without division', () => {
    const lost = buildCapacityPlan(demo({ weeklyAttrition: 1 }))
    expect(lost.weeks[0].baseline.productiveFte).toBe(80)
    expect(lost.weeks[1].scenario.paidHeadcount).toBe(10)
    expect(lost.weeks[2].scenario.paidHeadcount).toBe(0)
    const shrunk = buildCapacityPlan(demo({ shrinkage: 1 }))
    expect(shrunk.weeks[0].baseline.productiveFte).toBe(0)
    expect(shrunk.weeks[0].baseline.cost).toBe(100000)
    const zero = buildCapacityPlan(demo({ startingHeadcount: 0, requiredProductiveFte: Array(13).fill(0), paidHoursPerWeek: 40, hourlyCost: 0 }))
    expect(zero.baseline.firstShortageWeek).toBeNull()
    expect(zero.scenario.firstShortageWeek).toBeNull()
    expect(zero.scenario.totalCost).toBe(0)
    expect(zero.weeks.every(w => Number.isFinite(w.scenario.productiveFte) && w.scenario.cost === 0)).toBe(true)
  })

  it('suppresses roundoff shortages at equality while retaining real small shortages', () => {
    const config = demo({ startingHeadcount: 100, shrinkage: 0.8, requiredProductiveFte: Array(13).fill(20), hiringClass: { size: 0, startWeek: 1, trainingWeeks: 0, rampWeeks: 0 } })
    expect(buildCapacityPlan(config).baseline.firstShortageWeek).toBeNull()
    expect(buildCapacityPlan(config).weeks[0].baseline.balanceFte).toBe(0)
    config.requiredProductiveFte = Array(13).fill(20.000001)
    expect(buildCapacityPlan(config).baseline.firstShortageWeek).toBe(1)
    expect(buildCapacityPlan(config).weeks[0].baseline.shortageFte).toBeCloseTo(0.000001, 10)
  })

  it('keeps maximum-bound outputs finite and costs within safe integer magnitude', () => {
    const plan = buildCapacityPlan(demo({ startingHeadcount: CAPACITY_LIMITS.headcount, hourlyCost: CAPACITY_LIMITS.hourlyCost, paidHoursPerWeek: 168, requiredProductiveFte: Array(13).fill(1000000), shrinkage: 0, hiringClass: { size: 1000000, startWeek: 1, trainingWeeks: 0, rampWeeks: 0 } }))
    const numbers: number[] = []
    JSON.stringify(plan, (_key, value) => { if (typeof value === 'number') numbers.push(value); return value })
    expect(numbers.every(Number.isFinite)).toBe(true)
    expect(plan.scenario.totalCost).toBe(436800000000000)
    expect(plan.scenario.totalCost).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('does not mutate frozen input and returns independently owned output', () => {
    const config = Object.freeze(demo({ requiredProductiveFte: Object.freeze(Array(13).fill(78)), hiringClass: Object.freeze({ size: 10, startWeek: 2, trainingWeeks: 2, rampWeeks: 2 }) }))
    const first = buildCapacityPlan(config)
    first.weeks[0].baseline.cost = 0
    expect(buildCapacityPlan(config).weeks[0].baseline.cost).toBe(100000)
  })
})

describe('validateCapacityConfig', () => {
  it.each([null, undefined, [], {}, 'settings'])('rejects malformed root %j', input => {
    expect(() => validateCapacityConfig(input)).toThrow()
  })

  it.each(['startingHeadcount', 'weeklyAttrition', 'paidHoursPerWeek', 'shrinkage', 'hourlyCost'])('rejects invalid %s', field => {
    for (const value of [NaN, Infinity, -Infinity, -1, '1', null, undefined, Number.MAX_VALUE]) {
      expect(() => validateCapacityConfig({ ...demo(), [field]: value })).toThrow(field)
    }
  })

  it.each(['size', 'startWeek', 'trainingWeeks', 'rampWeeks'])('rejects invalid hiring %s even when disabled', field => {
    for (const value of [NaN, Infinity, -1, '1', null, undefined, Number.MAX_VALUE]) {
      expect(() => validateCapacityConfig({ ...demo(), hiringClass: { ...demo().hiringClass, size: 0, [field]: value } })).toThrow(field)
    }
  })

  it('rejects fractional durations, out-of-plan arrival, missing class and malformed demand', () => {
    for (const field of ['startWeek', 'trainingWeeks', 'rampWeeks']) {
      expect(() => validateCapacityConfig({ ...demo(), hiringClass: { ...demo().hiringClass, [field]: 1.5 } })).toThrow(field)
    }
    for (const startWeek of [0, 14]) expect(() => validateCapacityConfig({ ...demo(), hiringClass: { ...demo().hiringClass, startWeek } })).toThrow('startWeek')
    for (const hiringClass of [null, [], undefined]) expect(() => validateCapacityConfig({ ...demo(), hiringClass })).toThrow('hiringClass')
    for (const requiredProductiveFte of [[], Array(12).fill(0), Array(14).fill(0), Array(13), null, Array(13).fill(NaN), Array(13).fill(Infinity), Array(13).fill(-1), Array(13).fill(1000001)]) {
      expect(() => validateCapacityConfig({ ...demo(), requiredProductiveFte })).toThrow('requiredProductiveFte')
    }
  })
})
