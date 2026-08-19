import type { IntervalRecord } from './types'
import type { CapacityAssumptions, CapacityPlan, CapacityWeek, SolverConstraints } from './capacityTypes'
import { planWeeks, projectedServiceLevel, seedWeeklyBaseline, weeklyDemand } from './capacityDemand'
import { suggestHiring, supplyWalk } from './capacitySupply'

/**
 * Capacity plan orchestrator: demand (interval-true FTE) + supply (headcount
 * walk) per plan week, over/(under), projected weekly service level at the
 * supplied staffing, and greedy hiring suggestions for the shortfall weeks.
 * Pure and deterministic; the UI memoizes on (records, assumptions).
 */
export function buildCapacityPlan(
  records: IntervalRecord[],
  assumptions: CapacityAssumptions,
  constraints?: SolverConstraints,
  adjustments?: Map<string, number>,
): CapacityPlan {
  const lastDate = records.reduce((max, r) => (r.ts > max ? r.ts : max), '').slice(0, 10)
  if (lastDate === '') throw new Error('buildCapacityPlan: no records')
  const mondays = planWeeks(lastDate, assumptions.weeks)

  const demand = weeklyDemand(records, assumptions.queue, assumptions, mondays)
  const supply = supplyWalk(assumptions, mondays, adjustments)

  const weeks: CapacityWeek[] = mondays.map((week, i) => {
    const d = demand[i]
    const s = supply[i]
    const shrinkage = assumptions.shrinkageByWeek.get(week) ?? assumptions.defaultShrinkage
    return {
      week,
      volume: d.volume,
      aht: d.aht,
      requiredFte: d.requiredFte,
      productionHc: s.productionHc,
      inTrainingHc: s.inTrainingHc,
      supplyFte: s.supplyFte,
      overUnder: s.supplyFte - d.requiredFte,
      projectedSl: projectedServiceLevel(
        d.intervals,
        s.supplyFte,
        shrinkage,
        assumptions.staffing,
        assumptions.paidHoursPerWeek,
      ),
    }
  })

  const shortfalls = weeks
    .filter((w) => w.overUnder < 0)
    .map((w) => ({ week: w.week, gap: -w.overUnder }))
  const solverSuggestions =
    constraints && shortfalls.length > 0
      ? suggestHiring(shortfalls, assumptions, constraints, mondays)
      : []

  return {
    queue: assumptions.queue,
    weeks,
    seededBaseline: seedWeeklyBaseline(records, assumptions.queue, mondays),
    solverSuggestions,
  }
}
