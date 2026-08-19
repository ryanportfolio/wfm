import { describe, expect, it } from 'vitest'
import type { CapacityAssumptions, SolverConstraints } from './capacityTypes'
import { applyCapacityScenario, suggestHiring, supplyWalk, weeklyAttritionRate } from './capacitySupply'
import { addDays } from './series'
import type { StaffingConfig } from './staffing'

/** n consecutive Mondays starting at a known Monday. */
function mondays(start: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(addDays(start, i * 7))
  return out
}

const staffing: StaffingConfig = {
  mode: 'erlangA',
  slPct: 0.8,
  slSeconds: 20,
  patienceSec: 120,
  shrinkage: 0.3,
  intervalSec: 1800,
}

function baseAssumptions(overrides: Partial<CapacityAssumptions> = {}): CapacityAssumptions {
  return {
    queue: 'voice',
    weeks: 12,
    paidHoursPerWeek: 40,
    growthWeeklyPct: 0,
    volumeOverrides: new Map(),
    ahtOverrides: new Map(),
    shrinkageByWeek: new Map(),
    defaultShrinkage: 0.3,
    attritionAnnualPct: 0.3,
    trainingAttritionPct: 0.1,
    startingProductionHc: 100,
    rampWeeks: 4,
    hireClasses: [],
    staffing,
    ...overrides,
  }
}

// 2026-01-05 is a Monday.
const PLAN12 = mondays('2026-01-05', 12)

describe('supplyWalk', () => {
  /**
   * Hand-computed 12-week walk.
   *
   * startingProductionHc = 100, attrition 30%/yr:
   *   weekly rate r = 1 - 0.7^(1/52) = 0.0068357 (q = 1 - r = 0.9931643)
   *   production before graduates at week w = 100 * q^w
   *     q^1 = 0.9931643, q^5 = 0.9662858, q^7 = 0.9531205, q^12 = 0.9209868
   *
   * One class of 20, start week 1, 4 training + 2 nesting, 10% training
   * attrition (front-loaded): 18 heads for weeks 1-6, graduates 18 at week 7.
   * Nesting weeks 5-6 at productivity 0.5 -> +9 supply FTE.
   * rampWeeks = 4: grad cohort ramp 0.5 (wk7), 0.625, 0.75, 0.875, 1.0 (wk11).
   *
   * Week 1:  production = 99.3164, inTraining = 18, supply = 99.3164
   * Week 5:  production = 96.6286, inTraining = 18, supply = 96.6286 + 9 = 105.6286
   * Week 7:  production = 95.3121 + 18 = 113.3121, inTraining = 0,
   *          supply = 95.3121 + 18 * 0.5 = 104.3121
   * Week 12: base = 92.0987; grad cohort = 18 * q^5 = 17.3931 (attrited wks 8-12),
   *          ramp = 1.0 (age 5 >= 4); production = supply = 109.4918
   */
  it('matches the hand-computed 12-week walk with one hire class', () => {
    const a = baseAssumptions({
      hireClasses: [
        {
          id: 'c1',
          startWeek: PLAN12[0],
          size: 20,
          trainingWeeks: 4,
          nestingWeeks: 2,
          nestingProductivity: 0.5,
        },
      ],
    })
    const walk = supplyWalk(a, PLAN12)

    expect(walk[0].productionHc).toBeCloseTo(99.3164, 3)
    expect(walk[0].inTrainingHc).toBeCloseTo(18, 10)
    expect(walk[0].supplyFte).toBeCloseTo(99.3164, 3)

    expect(walk[4].productionHc).toBeCloseTo(96.6286, 3)
    expect(walk[4].inTrainingHc).toBeCloseTo(18, 10)
    expect(walk[4].supplyFte).toBeCloseTo(105.6286, 3)

    expect(walk[6].productionHc).toBeCloseTo(113.3121, 3)
    expect(walk[6].inTrainingHc).toBe(0)
    expect(walk[6].supplyFte).toBeCloseTo(104.3121, 3)

    expect(walk[11].productionHc).toBeCloseTo(109.4918, 3)
    expect(walk[11].inTrainingHc).toBe(0)
    expect(walk[11].supplyFte).toBeCloseTo(109.4918, 3)
  })

  it('compounds production attrition to the closed form (1-annual)^(w/52)', () => {
    const walk = supplyWalk(baseAssumptions(), PLAN12)
    for (let w = 1; w <= 12; w++) {
      expect(walk[w - 1].productionHc).toBeCloseTo(100 * Math.pow(0.7, w / 52), 9)
    }
    expect(weeklyAttritionRate(0.3)).toBeCloseTo(1 - Math.pow(0.7, 1 / 52), 12)
    expect(weeklyAttritionRate(0)).toBe(0)
  })

  it('ramps a graduated cohort linearly and hits 1.0 exactly after rampWeeks', () => {
    // Zero attrition everywhere so ramp is the only moving part.
    // Class of 10, 1 training + 1 nesting: graduates at week 3 (index 2).
    const a = baseAssumptions({
      attritionAnnualPct: 0,
      trainingAttritionPct: 0,
      hireClasses: [
        {
          id: 'c1',
          startWeek: PLAN12[0],
          size: 10,
          trainingWeeks: 1,
          nestingWeeks: 1,
          nestingProductivity: 0.5,
        },
      ],
    })
    const walk = supplyWalk(a, PLAN12)
    // Ages 0..4 after graduation: 0.5, 0.625, 0.75, 0.875, 1.0.
    expect(walk[2].supplyFte).toBeCloseTo(100 + 10 * 0.5, 12)
    expect(walk[3].supplyFte).toBeCloseTo(100 + 10 * 0.625, 12)
    expect(walk[5].supplyFte).toBeCloseTo(100 + 10 * 0.875, 12)
    expect(walk[6].supplyFte).toBe(110) // exactly 1.0 at age = rampWeeks
    expect(walk[11].supplyFte).toBe(110) // stays at 1.0 afterwards
  })

  it('applies manual adjustments after attrition, as fully ramped transfers', () => {
    const a = baseAssumptions({ attritionAnnualPct: 0 })
    const adjustments = new Map([
      [PLAN12[2], 5], // +5 transfers in at week 3
      [PLAN12[5], -3], // -3 transfers out at week 6
    ])
    const walk = supplyWalk(a, PLAN12, adjustments)
    expect(walk[1].productionHc).toBe(100)
    expect(walk[2].productionHc).toBe(105)
    expect(walk[4].productionHc).toBe(105)
    expect(walk[5].productionHc).toBe(102)
    expect(walk[11].supplyFte).toBe(102)
  })
})

describe('suggestHiring', () => {
  const PLAN20 = mondays('2026-01-05', 20)
  const constraints: SolverConstraints = {
    minClassSize: 5,
    maxClassSize: 25,
    maxClassesPerQuarter: 2,
    trainingWeeks: 4,
    nestingWeeks: 2,
    nestingProductivity: 0.5,
  }
  // Zero production attrition keeps the arithmetic exact: baseline supply is
  // a flat 100 FTE, so required = 100 + gap.
  const solverAssumptions = baseAssumptions({
    weeks: 20,
    attritionAnnualPct: 0,
    trainingAttritionPct: 0.1,
  })
  const cliff = (gap: number, fromIndex: number) =>
    PLAN20.slice(fromIndex).map((week) => ({ week, gap }))

  it('covers a 10-FTE cliff at week 12 with one just-big-enough class', () => {
    // Gap of 10 for weeks 12-20 (indices 11-19). Lead time 4+2 = 6 weeks, so
    // the class starts at index 5 and graduates at index 11. At graduation
    // the cohort is worth size * 0.9 (training attrition) * 0.5 (ramp start):
    // size 22 -> 9.9 (short), size 23 -> 10.35 (covers). Later window weeks
    // only ramp up, so 23 is the smallest covering size.
    const suggestions = suggestHiring(cliff(10, 11), solverAssumptions, constraints, PLAN20)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].size).toBe(23)
    expect(suggestions[0].startWeek).toBe(PLAN20[5])
    expect(suggestions[0].trainingWeeks).toBe(4)
    expect(suggestions[0].nestingWeeks).toBe(2)

    // (a) Coverage restored by week 12 for the whole window.
    const walk = supplyWalk({ ...solverAssumptions, hireClasses: suggestions }, PLAN20)
    for (let i = 11; i < 20; i++) {
      expect(walk[i].supplyFte).toBeGreaterThanOrEqual(110 - 1e-9)
    }
    // No overshoot before the cliff beyond nesting spillover.
    expect(walk[10].supplyFte).toBeCloseTo(100 + 23 * 0.9 * 0.5, 9)
  })

  it('stacks classes under maxClassesPerQuarter and writes off unreachable weeks', () => {
    // 40-FTE cliff at index 11. One max class (25 heads) yields
    // 25 * 0.9 * 0.5 = 11.25 at graduation, so the greedy stacks two max
    // classes at index 5 (both 2026 Q1, hitting the 2-per-quarter cap).
    // Together they supply 45 * ramp: still short for ages 0-3
    // (45 * 0.875 = 39.375 at index 14), covered from index 15 (ramp 1.0).
    // The third attempt must start in Q2 (index 13, 2026-04-06), graduating
    // at index 19, past the remaining window 11-14: those weeks are written
    // off and a minimum-size class is placed.
    const suggestions = suggestHiring(cliff(40, 11), solverAssumptions, constraints, PLAN20)
    expect(suggestions).toHaveLength(3)
    expect(suggestions[0]).toMatchObject({ size: 25, startWeek: PLAN20[5] })
    expect(suggestions[1]).toMatchObject({ size: 25, startWeek: PLAN20[5] })
    expect(suggestions[2]).toMatchObject({ size: 5, startWeek: PLAN20[13] })

    // (b) Constraint compliance.
    const perQuarter = new Map<string, number>()
    for (const s of suggestions) {
      expect(s.size).toBeGreaterThanOrEqual(constraints.minClassSize)
      expect(s.size).toBeLessThanOrEqual(constraints.maxClassSize)
      const q = `${s.startWeek.slice(0, 4)}-Q${Math.floor((Number(s.startWeek.slice(5, 7)) - 1) / 3) + 1}`
      perQuarter.set(q, (perQuarter.get(q) ?? 0) + 1)
    }
    for (const n of perQuarter.values()) expect(n).toBeLessThanOrEqual(2)

    // Fully covered once both big cohorts are fully ramped.
    const walk = supplyWalk({ ...solverAssumptions, hireClasses: suggestions }, PLAN20)
    for (let i = 15; i < 20; i++) {
      expect(walk[i].supplyFte).toBeGreaterThanOrEqual(140 - 1e-9)
    }
  })

  it('places the earliest possible class when lead time exceeds the runway', () => {
    // Shortfall at weeks 2-4 (indices 1-3), lead time 6: nothing can graduate
    // by index 3. The solver places the earliest possible class (index 0,
    // minimum size, graduating at index 6) and terminates instead of looping.
    const shortfalls = [1, 2, 3].map((i) => ({ week: PLAN20[i], gap: 5 }))
    const suggestions = suggestHiring(shortfalls, solverAssumptions, constraints, PLAN20)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].size).toBe(constraints.minClassSize)
    expect(suggestions[0].startWeek).toBe(PLAN20[0])
  })

  it('suggests nothing when there is no shortfall', () => {
    expect(suggestHiring([], solverAssumptions, constraints, PLAN20)).toEqual([])
    const negative = PLAN20.map((week) => ({ week, gap: -4 }))
    expect(suggestHiring(negative, solverAssumptions, constraints, PLAN20)).toEqual([])
  })
})

describe('applyCapacityScenario', () => {
  it('applies overrides to a copy and leaves the base unmutated', () => {
    const base = baseAssumptions({
      volumeOverrides: new Map([['2026-01-05', 5000]]),
      shrinkageByWeek: new Map([['2026-01-05', 0.35]]),
      hireClasses: [
        {
          id: 'c1',
          startWeek: '2026-01-05',
          size: 12,
          trainingWeeks: 6,
          nestingWeeks: 4,
          nestingProductivity: 0.5,
        },
      ],
    })
    const { assumptions, ahtDeltaPct } = applyCapacityScenario(base, {
      growthWeeklyPct: 0.004,
      attritionAnnualPct: 0.4,
      defaultShrinkage: 0.35,
      ahtDeltaPct: 0.05,
    })

    expect(assumptions.growthWeeklyPct).toBe(0.004)
    expect(assumptions.attritionAnnualPct).toBe(0.4)
    expect(assumptions.defaultShrinkage).toBe(0.35)
    expect(ahtDeltaPct).toBe(0.05)
    // Non-overridden fields carried through.
    expect(assumptions.startingProductionHc).toBe(100)
    expect(assumptions.volumeOverrides.get('2026-01-05')).toBe(5000)

    // Base untouched.
    expect(base.growthWeeklyPct).toBe(0)
    expect(base.attritionAnnualPct).toBe(0.3)
    expect(base.defaultShrinkage).toBe(0.3)

    // Deep-enough copy: mutating the scenario never leaks into the base.
    assumptions.volumeOverrides.set('2026-01-12', 9999)
    assumptions.shrinkageByWeek.set('2026-01-05', 0.5)
    assumptions.hireClasses[0].size = 99
    expect(base.volumeOverrides.has('2026-01-12')).toBe(false)
    expect(base.shrinkageByWeek.get('2026-01-05')).toBe(0.35)
    expect(base.hireClasses[0].size).toBe(12)
  })

  it('defaults ahtDeltaPct to 0 when omitted', () => {
    const base = baseAssumptions()
    const { assumptions, ahtDeltaPct } = applyCapacityScenario(base, { attritionAnnualPct: 0.25 })
    expect(ahtDeltaPct).toBe(0)
    expect(assumptions.attritionAnnualPct).toBe(0.25)
    expect(base.attritionAnnualPct).toBe(0.3)
  })
})
