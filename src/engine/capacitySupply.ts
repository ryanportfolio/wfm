import type { CapacityAssumptions, HireClass, SolverConstraints } from './capacityTypes'

/**
 * Supply side of the capacity planner (docs/design-capacity.md, "Supply block").
 *
 * Pure functions, no React, no dependency on the demand module.
 *
 * Units note: supplyFte here is in scheduled-FTE terms, BEFORE shrinkage.
 * The demand side's requiredFte is post-gross-up scheduled FTE (agent-hours
 * divided by (1 - shrinkage)), so the two lines compare directly and
 * overUnder = supplyFte - requiredFte needs no further shrinkage handling.
 */

export interface SupplyWeek {
  week: string
  /** Graduated (production) headcount, fractional heads allowed: plan, not roster */
  productionHc: number
  /** Heads currently in training or nesting */
  inTrainingHc: number
  /** Productive scheduled FTE: sum(cohort hc * rampFactor) + nesting contribution */
  supplyFte: number
}

/** Weekly production attrition rate from an annual fraction, compounding. */
export function weeklyAttritionRate(attritionAnnualPct: number): number {
  return 1 - Math.pow(1 - attritionAnnualPct, 1 / 52)
}

interface Cohort {
  /** Heads remaining in the cohort (eroded weekly by production attrition) */
  hc: number
  /** planMondays index of the graduation week; negative = fully ramped at plan start */
  gradIndex: number
}

/** Linear ramp: 0.5 at graduation, 1.0 once ageWeeks >= rampWeeks. */
function rampFactor(ageWeeks: number, rampWeeks: number): number {
  if (rampWeeks <= 0) return 1
  return Math.min(1, 0.5 + 0.5 * (ageWeeks / rampWeeks))
}

/**
 * Week-by-week headcount walk.
 *
 * Order within a week w: (1) production attrition erodes every existing
 * cohort, (2) classes finishing nesting graduate in (not attrited in their
 * graduation week), (3) manual adjustments apply. Matches the design doc
 * recursion production_hc[w] = production_hc[w-1] + graduates[w]
 * - attrition[w] +/- adjustments[w].
 *
 * Training attrition is FRONT-LOADED: the whole trainingAttritionPct is
 * removed at class start, so a class of 20 with 10% training attrition shows
 * 18 heads for all of training and nesting and graduates 18. Chosen over a
 * linear erosion for hand-checkable arithmetic; the design doc allows it.
 *
 * Hire classes whose startWeek is not one of planMondays are ignored.
 *
 * Adjustments (optional Map keyed by week Monday) are net transfers in/out of
 * production, assumed fully ramped, and are subject to production attrition
 * in the weeks after they land.
 */
export function supplyWalk(
  assumptions: CapacityAssumptions,
  planMondays: string[],
  adjustments?: Map<string, number>,
): SupplyWeek[] {
  const weekIndex = new Map<string, number>()
  planMondays.forEach((w, i) => weekIndex.set(w, i))
  const weeklyRate = weeklyAttritionRate(assumptions.attritionAnnualPct)

  interface ClassState {
    survivedHc: number
    startIndex: number
    nestingStartIndex: number
    gradIndex: number
    nestingProductivity: number
  }
  const classes: ClassState[] = []
  for (const hc of assumptions.hireClasses) {
    const startIndex = weekIndex.get(hc.startWeek)
    if (startIndex === undefined) continue
    classes.push({
      survivedHc: hc.size * (1 - assumptions.trainingAttritionPct),
      startIndex,
      nestingStartIndex: startIndex + hc.trainingWeeks,
      gradIndex: startIndex + hc.trainingWeeks + hc.nestingWeeks,
      nestingProductivity: hc.nestingProductivity,
    })
  }

  // Starting production headcount is one fully ramped cohort.
  const cohorts: Cohort[] = [{ hc: assumptions.startingProductionHc, gradIndex: -assumptions.rampWeeks - 1 }]
  // Fully ramped bucket for net manual transfers.
  const transferCohort: Cohort = { hc: 0, gradIndex: -assumptions.rampWeeks - 1 }
  cohorts.push(transferCohort)

  const out: SupplyWeek[] = []
  for (let i = 0; i < planMondays.length; i++) {
    const week = planMondays[i]
    // 1. Production attrition on every existing cohort.
    for (const c of cohorts) c.hc *= 1 - weeklyRate
    // 2. Graduations.
    for (const cl of classes) {
      if (cl.gradIndex === i) cohorts.push({ hc: cl.survivedHc, gradIndex: i })
    }
    // 3. Manual adjustments.
    transferCohort.hc += adjustments?.get(week) ?? 0

    let productionHc = 0
    let supplyFte = 0
    for (const c of cohorts) {
      productionHc += c.hc
      supplyFte += c.hc * rampFactor(i - c.gradIndex, assumptions.rampWeeks)
    }
    let inTrainingHc = 0
    for (const cl of classes) {
      if (i >= cl.startIndex && i < cl.gradIndex) {
        inTrainingHc += cl.survivedHc
        if (i >= cl.nestingStartIndex) supplyFte += cl.survivedHc * cl.nestingProductivity
      }
    }
    out.push({ week, productionHc, inTrainingHc, supplyFte })
  }
  return out
}

/** Calendar-quarter key ("2026-Q1") for a week Monday. */
function quarterKey(weekMonday: string): string {
  const month = Number(weekMonday.slice(5, 7))
  return `${weekMonday.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`
}

const SOLVER_CLASS_CAP = 50
const GAP_EPS = 1e-6

/**
 * Greedy hiring suggestion solver (design doc, "Bottom line and solver").
 *
 * Input gaps are against the CURRENT plan supply (gap = requiredFte -
 * supplyFte, positive = short). The solver reconstructs requiredFte from the
 * baseline walk plus the gaps, then repeatedly: finds the first week still
 * short, takes the contiguous shortfall window from there, and places one
 * class starting trainingWeeks + nestingWeeks before the window (clamped to
 * the plan start and shifted later past full quarters), sized as the smallest
 * integer in [minClassSize, maxClassSize] whose graduates close the whole
 * window. If even maxClassSize cannot close it, maxClassSize is placed and
 * the loop continues. If graduation cannot land by the window start (lead
 * time exceeds runway, or quarter caps push the start too late), the earliest
 * possible class is placed and the weeks before its graduation are written
 * off as uncoverable.
 *
 * Every candidate is evaluated by re-running supplyWalk with the candidate
 * class added: correctness over cleverness.
 *
 * Greedy limitations, stated per the design doc: classes always target
 * graduation at the window start, so it never trades an earlier start (more
 * ramp, smaller class) against a later one; it sizes each class against the
 * current window only, so a cheaper global mix of fewer, larger classes can
 * exist; it stops at a 50-class safety cap.
 */
export function suggestHiring(
  shortfalls: { week: string; gap: number }[],
  assumptions: CapacityAssumptions,
  constraints: SolverConstraints,
  planMondays: string[],
): HireClass[] {
  const baseline = supplyWalk(assumptions, planMondays)
  const requiredFte = baseline.map((w) => w.supplyFte)
  const gapByWeek = new Map(shortfalls.map((s) => [s.week, s.gap]))
  for (let i = 0; i < planMondays.length; i++) {
    requiredFte[i] += gapByWeek.get(planMondays[i]) ?? 0
  }

  const leadWeeks = constraints.trainingWeeks + constraints.nestingWeeks
  const suggested: HireClass[] = []
  const givenUp = new Set<number>()

  const quarterCount = new Map<string, number>()
  const countClass = (startWeek: string) => {
    const q = quarterKey(startWeek)
    quarterCount.set(q, (quarterCount.get(q) ?? 0) + 1)
  }
  for (const hc of assumptions.hireClasses) countClass(hc.startWeek)

  const makeClass = (startIndex: number, size: number): HireClass => ({
    id: `suggested-${suggested.length + 1}`,
    startWeek: planMondays[startIndex],
    size,
    trainingWeeks: constraints.trainingWeeks,
    nestingWeeks: constraints.nestingWeeks,
    nestingProductivity: constraints.nestingProductivity,
  })

  const walkWith = (candidate?: HireClass) =>
    supplyWalk(
      {
        ...assumptions,
        hireClasses: [...assumptions.hireClasses, ...suggested, ...(candidate ? [candidate] : [])],
      },
      planMondays,
    )

  while (suggested.length < SOLVER_CLASS_CAP) {
    const walk = walkWith()
    const gaps = walk.map((w, i) => requiredFte[i] - w.supplyFte)

    let windowStart = -1
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] > GAP_EPS && !givenUp.has(i)) {
        windowStart = i
        break
      }
    }
    if (windowStart < 0) break

    let windowEnd = windowStart
    while (windowEnd + 1 < gaps.length && gaps[windowEnd + 1] > GAP_EPS) windowEnd++

    // Earliest start whose quarter still has room, no earlier than the plan
    // start, targeting graduation at the window start.
    let startIndex = Math.max(0, windowStart - leadWeeks)
    while (
      startIndex < planMondays.length &&
      (quarterCount.get(quarterKey(planMondays[startIndex])) ?? 0) >= constraints.maxClassesPerQuarter
    ) {
      startIndex++
    }
    if (startIndex >= planMondays.length) {
      // No quarter has room for any further class covering this window.
      for (let i = windowStart; i <= windowEnd; i++) givenUp.add(i)
      continue
    }

    const gradIndex = startIndex + leadWeeks
    // Weeks the class can never reach are written off.
    for (let i = windowStart; i <= windowEnd && i < gradIndex; i++) givenUp.add(i)
    const coverFrom = Math.max(windowStart, gradIndex)
    if (coverFrom > windowEnd) {
      // Graduation lands past the whole window: place the smallest class
      // anyway (it can only help later weeks) and move on.
      suggested.push(makeClass(startIndex, constraints.minClassSize))
      countClass(planMondays[startIndex])
      continue
    }

    const covers = (size: number): boolean => {
      const trial = walkWith(makeClass(startIndex, size))
      for (let i = coverFrom; i <= windowEnd; i++) {
        if (requiredFte[i] - trial[i].supplyFte > GAP_EPS) return false
      }
      return true
    }

    let size: number
    if (!covers(constraints.maxClassSize)) {
      // Even the biggest class cannot close the window: place it and let the
      // next iteration stack another class on the remainder.
      size = constraints.maxClassSize
    } else {
      // Smallest covering integer size via binary search (covers is monotone
      // in size).
      let lo = constraints.minClassSize
      let hi = constraints.maxClassSize
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (covers(mid)) hi = mid
        else lo = mid + 1
      }
      size = lo
    }
    suggested.push(makeClass(startIndex, size))
    countClass(planMondays[startIndex])
  }

  return suggested
}

/**
 * Scenario overlay (design doc, "Scenarios and sensitivity").
 *
 * Returns { assumptions, ahtDeltaPct }: a deep-enough copy of the base
 * assumptions with the scalar overrides applied, plus the AHT delta as a
 * separate value because AHT lives on the demand side; the caller multiplies
 * its weekly AHT by (1 + ahtDeltaPct). CapacityAssumptions is kept free of
 * scenario-only fields on purpose.
 *
 * Maps and the hireClasses array are cloned so edits to the scenario copy
 * never leak into the base.
 */
export function applyCapacityScenario(
  base: CapacityAssumptions,
  overrides: Partial<Pick<CapacityAssumptions, 'growthWeeklyPct' | 'attritionAnnualPct' | 'defaultShrinkage'>> & {
    ahtDeltaPct?: number
  },
): { assumptions: CapacityAssumptions; ahtDeltaPct: number } {
  const { ahtDeltaPct = 0, ...scalarOverrides } = overrides
  const assumptions: CapacityAssumptions = {
    ...base,
    volumeOverrides: new Map(base.volumeOverrides),
    ahtOverrides: new Map(base.ahtOverrides),
    shrinkageByWeek: new Map(base.shrinkageByWeek),
    hireClasses: base.hireClasses.map((hc) => ({ ...hc })),
    ...scalarOverrides,
  }
  return { assumptions, ahtDeltaPct }
}
