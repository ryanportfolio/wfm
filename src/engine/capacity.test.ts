import { describe, expect, it } from 'vitest'
import { buildCapacityPlan, CAPACITY_LIMITS, capacitySensitivity, validateCapacityConfig } from './capacity'
import type { CapacityConfig, HiringClass } from './capacity'

function cls(overrides: Partial<HiringClass> = {}): HiringClass {
  return { size: 10, startWeek: 2, trainingWeeks: 2, nestingWeeks: 0, nestingProductivity: 0, rampWeeks: 2, ...overrides }
}

function demo(overrides: Partial<CapacityConfig> = {}): CapacityConfig {
  return {
    requiredProductiveFte: [78, 78, 78, 78, 78, 78, 84, 84, 84, 84, 84, 84, 84],
    startingHeadcount: 100, weeklyAttrition: 0, newHireWeeklyAttrition: 0, paidHoursPerWeek: 40,
    shrinkage: 0.2, hourlyCost: 25,
    hiringClasses: [cls()],
    ...overrides,
  }
}

/** The single-class model before hiring classes, nesting and new-hire attrition, copied verbatim. */
function legacyPlan(config: { requiredProductiveFte: number[]; startingHeadcount: number; weeklyAttrition: number; paidHoursPerWeek: number; shrinkage: number; hourlyCost: number; hiringClass: { size: number; startWeek: number; trainingWeeks: number; rampWeeks: number } }) {
  const supply = (demand: number, existing: number, hires: number, productivity: number) => {
    const paidHeadcount = existing + hires
    const paidHours = paidHeadcount * config.paidHoursPerWeek
    const productiveFte = (existing + hires * productivity) * (1 - config.shrinkage)
    const difference = productiveFte - demand
    const tolerance = 32 * Number.EPSILON * Math.max(1, productiveFte, demand)
    const balanceFte = Math.abs(difference) <= tolerance ? 0 : difference
    return { existingHeadcount: existing, hireHeadcount: hires, hireProductiveHeads: hires * productivity, paidHeadcount, paidHours, productiveFte, balanceFte,
      shortageFte: Math.max(0, -balanceFte), surplusFte: Math.max(0, balanceFte), cost: paidHours * config.hourlyCost }
  }
  const weeks = []
  const hiring = config.hiringClass
  let existing = config.startingHeadcount
  let hires = 0
  for (let week = 1; week <= 13; week++) {
    if (week > 1) existing *= 1 - config.weeklyAttrition
    if (week === hiring.startWeek) hires = hiring.size
    else if (week > hiring.startWeek) hires *= 1 - config.weeklyAttrition
    const productiveWeek = week - hiring.startWeek - hiring.trainingWeeks + 1
    const productivity = hires === 0 || productiveWeek <= 0 ? 0
      : hiring.rampWeeks === 0 ? 1 : Math.min(1, productiveWeek / hiring.rampWeeks)
    const demand = config.requiredProductiveFte[week - 1]
    const baseline = supply(demand, existing, 0, 0)
    const scenario = supply(demand, existing, hires, productivity)
    weeks.push({ week, requiredProductiveFte: demand, baseline, scenario, incrementalProductiveFte: scenario.productiveFte - baseline.productiveFte, incrementalCost: scenario.cost - baseline.cost })
  }
  return weeks
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
    expect(plan.weeks.slice(0, 6).map(w => w.classes[0].phase)).toEqual(['pending', 'training', 'training', 'ramp', 'ramp', 'productive'])
  })

  it('reproduces the single-class model exactly when nesting is zero and both attrition rates match', () => {
    let checked = 0
    for (const weeklyAttrition of [0, 0.035, 0.1, 1]) for (const shrinkage of [0, 0.2, 0.37]) for (const size of [0, 7.5, 10])
      for (const startWeek of [1, 2, 7, 13]) for (const trainingWeeks of [0, 2, 5]) for (const rampWeeks of [0, 1, 3, 52]) {
        const legacy = { requiredProductiveFte: [78, 78, 79.5, 78, 78, 78, 84, 84, 84, 84, 84, 90, 84], startingHeadcount: 100, weeklyAttrition, paidHoursPerWeek: 37.5, shrinkage, hourlyCost: 25.25, hiringClass: { size, startWeek, trainingWeeks, rampWeeks } }
        const { hiringClass: _class, ...rest } = legacy
        // Nesting productivity is ignored without nesting weeks.
        const plan = buildCapacityPlan({ ...rest, newHireWeeklyAttrition: weeklyAttrition, hiringClasses: [{ size, startWeek, trainingWeeks, nestingWeeks: 0, nestingProductivity: 0.6, rampWeeks }] })
        expect(plan.weeks.map(({ classes: _c, ...week }) => week)).toEqual(legacyPlan(legacy))
        checked++
      }
    expect(checked).toBe(1728)
  })

  it('attrits existing and hired heads only after arrival, including during training and ramp', () => {
    const plan = buildCapacityPlan(demo({ weeklyAttrition: 0.1, newHireWeeklyAttrition: 0.1 }))
    expect(plan.weeks.slice(0, 3).map(w => w.baseline.existingHeadcount)).toEqual([100, 90, 81])
    expect(plan.weeks.slice(0, 4).map(w => w.scenario.hireHeadcount)).toEqual([0, 10, 9, 8.1])
    expect(plan.weeks[3].classes[0].productivity).toBe(0.5)
    expect(plan.weeks[3].incrementalProductiveFte).toBeCloseTo(3.24, 10)
    expect(plan.weeks[4].incrementalProductiveFte).toBeCloseTo(5.832, 10)
    expect(plan.weeks[2].scenario.cost).toBe(90000)
    expect(plan.weeks[3].incrementalCost).toBeCloseTo(8100, 8)
  })

  it('applies new-hire attrition to hires only and tenured attrition to existing heads only', () => {
    const hires = buildCapacityPlan(demo({ newHireWeeklyAttrition: 0.1 }))
    expect(hires.weeks.slice(0, 4).map(w => w.scenario.existingHeadcount)).toEqual([100, 100, 100, 100])
    expect(hires.weeks.slice(0, 4).map(w => w.scenario.hireHeadcount)).toEqual([0, 10, 9, 8.1])
    const tenured = buildCapacityPlan(demo({ weeklyAttrition: 0.1 }))
    expect(tenured.weeks.slice(0, 3).map(w => w.scenario.existingHeadcount)).toEqual([100, 90, 81])
    expect(tenured.weeks.slice(0, 13).map(w => w.scenario.hireHeadcount)).toEqual([0, ...Array(12).fill(10)])
  })

  it('supplies nesting at its productivity, then ramps linearly from nesting productivity to 100%', () => {
    const plan = buildCapacityPlan(demo({ startingHeadcount: 0, shrinkage: 0, hiringClasses: [cls({ startWeek: 1, trainingWeeks: 1, nestingWeeks: 2, nestingProductivity: 0.5, rampWeeks: 2 })] }))
    expect(plan.weeks.slice(0, 6).map(w => w.classes[0].phase)).toEqual(['training', 'nesting', 'nesting', 'ramp', 'ramp', 'productive'])
    expect(plan.weeks.slice(0, 6).map(w => w.scenario.productiveFte)).toEqual([0, 5, 5, 7.5, 10, 10])
    // Nesting and training heads are paid in full.
    expect(plan.weeks.slice(0, 6).map(w => w.scenario.cost)).toEqual(Array(6).fill(10000))
    const fourRamp = buildCapacityPlan(demo({ startingHeadcount: 0, shrinkage: 0, hiringClasses: [cls({ startWeek: 1, trainingWeeks: 0, nestingWeeks: 1, nestingProductivity: 0.2, rampWeeks: 4 })] }))
    fourRamp.weeks.slice(0, 6).forEach((w, i) => expect(w.classes[0].productivity).toBeCloseTo([0.2, 0.4, 0.6, 0.8, 1, 1][i], 12))
    const noRamp = buildCapacityPlan(demo({ startingHeadcount: 0, shrinkage: 0.5, hiringClasses: [cls({ startWeek: 1, trainingWeeks: 0, nestingWeeks: 1, nestingProductivity: 0.4, rampWeeks: 0 })] }))
    expect(noRamp.weeks.slice(0, 2).map(w => w.scenario.productiveFte)).toEqual([2, 5])
  })

  it('sums independent classes, each with its own start, training, nesting and ramp', () => {
    const a = cls({ size: 10, startWeek: 1, trainingWeeks: 1, rampWeeks: 2 })
    const b = cls({ size: 6, startWeek: 4, trainingWeeks: 0, nestingWeeks: 2, nestingProductivity: 0.5, rampWeeks: 1 })
    const both = buildCapacityPlan(demo({ newHireWeeklyAttrition: 0.02, weeklyAttrition: 0.01, hiringClasses: [a, b] }))
    const onlyA = buildCapacityPlan(demo({ newHireWeeklyAttrition: 0.02, weeklyAttrition: 0.01, hiringClasses: [a] }))
    const onlyB = buildCapacityPlan(demo({ newHireWeeklyAttrition: 0.02, weeklyAttrition: 0.01, hiringClasses: [b] }))
    both.weeks.forEach((w, i) => {
      expect(w.classes).toEqual([onlyA.weeks[i].classes[0], onlyB.weeks[i].classes[0]])
      expect(w.scenario.hireHeadcount).toBeCloseTo(onlyA.weeks[i].scenario.hireHeadcount + onlyB.weeks[i].scenario.hireHeadcount, 10)
      expect(w.incrementalProductiveFte).toBeCloseTo(onlyA.weeks[i].incrementalProductiveFte + onlyB.weeks[i].incrementalProductiveFte, 10)
      expect(w.incrementalCost).toBeCloseTo(onlyA.weeks[i].incrementalCost + onlyB.weeks[i].incrementalCost, 6)
    })
    const flat = buildCapacityPlan(demo({ shrinkage: 0, hiringClasses: [a, b] }))
    expect(flat.weeks.slice(0, 7).map(w => w.scenario.hireProductiveHeads)).toEqual([0, 5, 10, 13, 13, 16, 16])
    expect(flat.weeks[6].scenario.paidHeadcount).toBe(116)
    expect(buildCapacityPlan(demo({ hiringClasses: [] })).incrementalCost).toBe(0)
  })

  it('supports immediate productive hires and a week 13 arrival', () => {
    for (const startWeek of [1, 13]) {
      const plan = buildCapacityPlan(demo({ hiringClasses: [cls({ startWeek, trainingWeeks: 0, rampWeeks: 0 })] }))
      expect(plan.weeks[startWeek - 1].scenario.productiveFte).toBe(88)
      expect(plan.weeks[startWeek - 1].incrementalCost).toBe(10000)
      if (startWeek === 13) {
        expect(plan.weeks[11].incrementalCost).toBe(0)
        expect(plan.incrementalCost).toBe(10000)
      }
    }
  })

  it('waits for full training weeks with zero ramp and allows training beyond the horizon', () => {
    const trained = buildCapacityPlan(demo({ hiringClasses: [cls({ startWeek: 1, trainingWeeks: 1, rampWeeks: 0 })] }))
    expect(trained.weeks[0].scenario.productiveFte).toBe(80)
    expect(trained.weeks[1].scenario.productiveFte).toBe(88)
    const longTraining = buildCapacityPlan(demo({ hiringClasses: [cls({ startWeek: 1, trainingWeeks: 52, rampWeeks: 52 })] }))
    expect(longTraining.weeks.every(w => w.incrementalProductiveFte === 0)).toBe(true)
    expect(longTraining.incrementalCost).toBe(130000)
  })

  it('uses a zero-size class as an exact disabled scenario', () => {
    const plan = buildCapacityPlan(demo({ hiringClasses: [cls({ size: 0, startWeek: 13, trainingWeeks: 52, rampWeeks: 52 })] }))
    expect(plan.baseline).toEqual(plan.scenario)
    for (const week of plan.weeks) expect(week.baseline).toEqual(week.scenario)
    expect(plan.incrementalCost).toBe(0)
  })

  it('handles total attrition, total shrinkage, zeros and zero-price hours without division', () => {
    const lost = buildCapacityPlan(demo({ weeklyAttrition: 1, newHireWeeklyAttrition: 1 }))
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
    const config = demo({ startingHeadcount: 100, shrinkage: 0.8, requiredProductiveFte: Array(13).fill(20), hiringClasses: [cls({ size: 0, startWeek: 1, trainingWeeks: 0, rampWeeks: 0 })] })
    expect(buildCapacityPlan(config).baseline.firstShortageWeek).toBeNull()
    expect(buildCapacityPlan(config).weeks[0].baseline.balanceFte).toBe(0)
    config.requiredProductiveFte = Array(13).fill(20.000001)
    expect(buildCapacityPlan(config).baseline.firstShortageWeek).toBe(1)
    expect(buildCapacityPlan(config).weeks[0].baseline.shortageFte).toBeCloseTo(0.000001, 10)
  })

  it('keeps maximum-bound outputs finite and costs within safe integer magnitude', () => {
    const plan = buildCapacityPlan(demo({ startingHeadcount: CAPACITY_LIMITS.headcount, hourlyCost: CAPACITY_LIMITS.hourlyCost, paidHoursPerWeek: 168, requiredProductiveFte: Array(13).fill(1000000), shrinkage: 0, hiringClasses: Array(12).fill(cls({ size: 1000000, startWeek: 1, trainingWeeks: 0, rampWeeks: 0 })) }))
    const numbers: number[] = []
    JSON.stringify(plan, (_key, value) => { if (typeof value === 'number') numbers.push(value); return value })
    expect(numbers.every(Number.isFinite)).toBe(true)
    expect(plan.scenario.totalCost).toBe(2839200000000000)
    expect(plan.scenario.totalCost).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  it('does not mutate frozen input and returns independently owned output', () => {
    const config = Object.freeze(demo({ requiredProductiveFte: Object.freeze(Array(13).fill(78)), hiringClasses: Object.freeze([Object.freeze(cls())]) }))
    const first = buildCapacityPlan(config)
    first.weeks[0].baseline.cost = 0
    expect(buildCapacityPlan(config).weeks[0].baseline.cost).toBe(100000)
    expect(capacitySensitivity(config).rows).toHaveLength(8)
  })
})

describe('validateCapacityConfig', () => {
  it.each([null, undefined, [], {}, 'settings'])('rejects malformed root %j', input => {
    expect(() => validateCapacityConfig(input)).toThrow()
  })

  it.each(['startingHeadcount', 'weeklyAttrition', 'newHireWeeklyAttrition', 'paidHoursPerWeek', 'shrinkage', 'hourlyCost'])('rejects invalid %s', field => {
    for (const value of [NaN, Infinity, -Infinity, -1, '1', null, undefined, Number.MAX_VALUE]) {
      expect(() => validateCapacityConfig({ ...demo(), [field]: value })).toThrow(field)
    }
  })

  it.each(['size', 'startWeek', 'trainingWeeks', 'nestingWeeks', 'nestingProductivity', 'rampWeeks'])('rejects invalid hiring %s even when disabled', field => {
    for (const value of [NaN, Infinity, -1, '1', null, undefined, Number.MAX_VALUE]) {
      expect(() => validateCapacityConfig({ ...demo(), hiringClasses: [cls(), { ...cls(), size: 0, [field]: value }] })).toThrow(`hiringClasses[1].${field}`)
    }
  })

  it('bounds the class count, nesting fields, durations, arrival and demand', () => {
    expect(() => validateCapacityConfig(demo({ hiringClasses: Array(12).fill(cls()) }))).not.toThrow()
    expect(() => validateCapacityConfig(demo({ hiringClasses: Array(13).fill(cls()) }))).toThrow('at most 12')
    expect(() => validateCapacityConfig(demo({ hiringClasses: [] }))).not.toThrow()
    for (const field of ['startWeek', 'trainingWeeks', 'nestingWeeks', 'rampWeeks']) {
      expect(() => validateCapacityConfig(demo({ hiringClasses: [{ ...cls(), [field]: 1.5 }] }))).toThrow(field)
    }
    expect(() => validateCapacityConfig(demo({ hiringClasses: [cls({ nestingWeeks: 52, nestingProductivity: 1 })] }))).not.toThrow()
    expect(() => validateCapacityConfig(demo({ hiringClasses: [cls({ nestingWeeks: 53 })] }))).toThrow('nestingWeeks')
    expect(() => validateCapacityConfig(demo({ hiringClasses: [cls({ nestingProductivity: 1.01 })] }))).toThrow('nestingProductivity')
    for (const startWeek of [0, 14]) expect(() => validateCapacityConfig(demo({ hiringClasses: [cls({ startWeek })] }))).toThrow('startWeek')
    for (const hiringClasses of [null, {}, undefined]) expect(() => validateCapacityConfig({ ...demo(), hiringClasses })).toThrow('hiringClasses')
    for (const entry of [null, [], 1]) expect(() => validateCapacityConfig({ ...demo(), hiringClasses: [entry] })).toThrow('hiringClasses[0]')
    for (const requiredProductiveFte of [[], Array(12).fill(0), Array(14).fill(0), Array(13), null, Array(13).fill(NaN), Array(13).fill(Infinity), Array(13).fill(-1), Array(13).fill(1000001)]) {
      expect(() => validateCapacityConfig({ ...demo(), requiredProductiveFte })).toThrow('requiredProductiveFte')
    }
  })
})

describe('capacitySensitivity', () => {
  // Proposal is short 2 FTE in weeks 7-13: 80 existing + 4 hires against 86.
  const short = () => demo({ requiredProductiveFte: [78, 78, 78, 78, 78, 78, 86, 86, 86, 86, 86, 86, 86], hiringClasses: [cls({ size: 5 })] })
  const row = (config: CapacityConfig, lever: string, direction: string) => capacitySensitivity(config).rows.find(r => r.lever === lever && r.direction === direction)!

  it('reports each lever in both directions against the unchanged proposal', () => {
    const config = short()
    const result = capacitySensitivity(config)
    expect(result.scenario).toEqual(buildCapacityPlan(config).scenario)
    expect(result.scenario.firstShortageWeek).toBe(7)
    expect(result.scenario.totalShortageFteWeeks).toBeCloseTo(14, 10)
    expect(result.rows.map(r => `${r.lever}:${r.direction}`)).toEqual(['demand:down', 'demand:up', 'tenuredAttrition:down', 'tenuredAttrition:up', 'shrinkage:down', 'shrinkage:up', 'newHireSize:down', 'newHireSize:up'])
    for (const r of result.rows) {
      expect(r.totalCostDelta).toBe(r.scenario.totalCost - result.scenario.totalCost)
      expect(r.totalShortageFteWeeksDelta).toBe(r.scenario.totalShortageFteWeeks - result.scenario.totalShortageFteWeeks)
    }
  })

  it('moves shortage and cost in the expected direction', () => {
    const config = short()
    const demandDown = row(config, 'demand', 'down'), demandUp = row(config, 'demand', 'up')
    expect(demandDown.value).toBe(0.9)
    expect(demandDown.scenario.firstShortageWeek).toBeNull()
    expect(demandDown.firstShortageWeekDelta).toBeNull()
    expect(demandDown.totalShortageFteWeeksDelta).toBeCloseTo(-14, 10)
    expect(demandUp.scenario.firstShortageWeek).toBe(1)
    expect(demandUp.firstShortageWeekDelta).toBe(-6)
    expect(demandUp.totalShortageFteWeeksDelta).toBeGreaterThan(0)
    expect(demandUp.totalCostDelta).toBe(0)
    const attritionUp = row(config, 'tenuredAttrition', 'up')
    expect(attritionUp.value).toBe(0.05)
    expect(attritionUp.totalShortageFteWeeksDelta).toBeGreaterThan(0)
    expect(attritionUp.totalCostDelta).toBeLessThan(0)
    const shrinkDown = row(config, 'shrinkage', 'down'), shrinkUp = row(config, 'shrinkage', 'up')
    expect(shrinkDown.value).toBeCloseTo(0.15, 12)
    expect(shrinkDown.scenario.firstShortageWeek).toBeNull()
    expect(shrinkUp.value).toBeCloseTo(0.25, 12)
    expect(shrinkUp.totalShortageFteWeeksDelta).toBeGreaterThan(0)
    expect(shrinkUp.totalCostDelta).toBe(0)
    const hiresDown = row(config, 'newHireSize', 'down'), hiresUp = row(config, 'newHireSize', 'up')
    expect([hiresDown.value, hiresUp.value]).toEqual([0.8, 1.2])
    expect(hiresDown.totalShortageFteWeeksDelta).toBeGreaterThan(0)
    expect(hiresDown.totalCostDelta).toBeCloseTo(-12 * 1 * 40 * 25, 6)
    expect(hiresUp.totalShortageFteWeeksDelta).toBeLessThan(0)
    expect(hiresUp.totalCostDelta).toBeCloseTo(12 * 1 * 40 * 25, 6)
    expect(hiresUp.firstShortageWeekDelta).toBe(0)
  })

  it('clamps attrition to 0..100% and shrinkage to 0..99% without lowering an entered maximum', () => {
    const zero = short()
    expect(row(zero, 'tenuredAttrition', 'down').value).toBe(0)
    expect(row(zero, 'tenuredAttrition', 'down').totalCostDelta).toBe(0)
    expect(row(zero, 'tenuredAttrition', 'down').totalShortageFteWeeksDelta).toBe(0)
    expect(row(demo({ weeklyAttrition: 0.98 }), 'tenuredAttrition', 'up').value).toBe(1)
    expect(row(demo({ shrinkage: 0.02 }), 'shrinkage', 'down').value).toBe(0)
    expect(row(demo({ shrinkage: 0.97 }), 'shrinkage', 'up').value).toBe(0.99)
    expect(row(demo({ shrinkage: 1 }), 'shrinkage', 'up').value).toBe(1)
    expect(row(demo({ hiringClasses: [] }), 'newHireSize', 'up').totalCostDelta).toBe(0)
    expect(() => capacitySensitivity({ ...demo(), shrinkage: 2 })).toThrow('shrinkage')
  })
})
