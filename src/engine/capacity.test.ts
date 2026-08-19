import { beforeAll, describe, expect, it } from 'vitest'
import type { IntervalRecord } from './types'
import type { CapacityAssumptions, SolverConstraints } from './capacityTypes'
import { generateSampleData } from './sampleData'
import { buildCapacityPlan } from './capacity'

let records: IntervalRecord[]

function baseAssumptions(): CapacityAssumptions {
  return {
    queue: 'voice-benefits',
    weeks: 52,
    paidHoursPerWeek: 40,
    growthWeeklyPct: 0.002,
    volumeOverrides: new Map(),
    ahtOverrides: new Map(),
    shrinkageByWeek: new Map(),
    defaultShrinkage: 0.3,
    attritionAnnualPct: 0.3,
    trainingAttritionPct: 0.1,
    startingProductionHc: 120,
    rampWeeks: 8,
    hireClasses: [],
    staffing: {
      mode: 'erlangA',
      slPct: 0.8,
      slSeconds: 20,
      patienceSec: 120,
      shrinkage: 0.3,
      occupancyCap: 0.9,
      intervalSec: 1800,
    },
  }
}

const CONSTRAINTS: SolverConstraints = {
  minClassSize: 5,
  maxClassSize: 30,
  maxClassesPerQuarter: 2,
  trainingWeeks: 6,
  nestingWeeks: 4,
  nestingProductivity: 0.5,
}

beforeAll(() => {
  records = generateSampleData()
})

describe('buildCapacityPlan integration', () => {
  it('produces a coherent 52-week plan on sample data in under a second', () => {
    const t0 = performance.now()
    const plan = buildCapacityPlan(records, baseAssumptions(), CONSTRAINTS)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(1000)

    expect(plan.weeks).toHaveLength(52)
    for (const w of plan.weeks) {
      expect(w.volume).toBeGreaterThan(0)
      expect(w.requiredFte).toBeGreaterThan(0)
      expect(w.overUnder).toBeCloseTo(w.supplyFte - w.requiredFte, 9)
      expect(w.projectedSl).toBeGreaterThanOrEqual(0)
      expect(w.projectedSl).toBeLessThanOrEqual(1)
    }
    // Attrition with no hiring: supply declines across the year.
    expect(plan.weeks[51].supplyFte).toBeLessThan(plan.weeks[0].supplyFte)
  })

  it('projected SL falls as unstaffed attrition erodes supply', () => {
    const plan = buildCapacityPlan(records, baseAssumptions())
    const early = plan.weeks.slice(0, 4).reduce((a, w) => a + w.projectedSl, 0) / 4
    const late = plan.weeks.slice(48).reduce((a, w) => a + w.projectedSl, 0) / 4
    expect(late).toBeLessThan(early)
  })

  it('solver suggestions close the gap when re-applied to the plan', () => {
    const assumptions = baseAssumptions()
    const first = buildCapacityPlan(records, assumptions, CONSTRAINTS)
    expect(first.solverSuggestions.length).toBeGreaterThan(0)

    const rerun = buildCapacityPlan(
      records,
      { ...assumptions, hireClasses: first.solverSuggestions },
      CONSTRAINTS,
    )
    const worstBefore = Math.min(...first.weeks.map((w) => w.overUnder))
    const worstAfter = Math.min(...rerun.weeks.map((w) => w.overUnder))
    expect(worstAfter).toBeGreaterThan(worstBefore)
    // Weeks reachable given lead time (training + nesting) end non-negative,
    // small numerical slack allowed.
    const lead = CONSTRAINTS.trainingWeeks + CONSTRAINTS.nestingWeeks
    for (const w of rerun.weeks.slice(lead + 1)) {
      expect(w.overUnder).toBeGreaterThan(-1)
    }
  })

  it('volume override propagates to demand and over/under', () => {
    const assumptions = baseAssumptions()
    const base = buildCapacityPlan(records, assumptions)
    const week10 = base.weeks[10].week
    assumptions.volumeOverrides.set(week10, base.weeks[10].volume * 2)
    const bumped = buildCapacityPlan(records, assumptions)
    expect(bumped.weeks[10].requiredFte).toBeGreaterThan(base.weeks[10].requiredFte * 1.5)
    expect(bumped.weeks[10].overUnder).toBeLessThan(base.weeks[10].overUnder)
    expect(bumped.weeks[9].requiredFte).toBeCloseTo(base.weeks[9].requiredFte, 9)
  })
})
