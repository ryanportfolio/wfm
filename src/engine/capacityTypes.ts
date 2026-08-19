import type { StaffingConfig } from './staffing'

/**
 * Shared types for the capacity planner (module 2, docs/design-capacity.md).
 * Weeks are identified by their Monday date, "YYYY-MM-DD".
 */

export interface HireClass {
  id: string
  /** Monday of the week the class starts training */
  startWeek: string
  size: number
  trainingWeeks: number
  nestingWeeks: number
  /** Productive FTE weight per head during nesting, 0..1 */
  nestingProductivity: number
}

export interface CapacityAssumptions {
  queue: string
  /** Number of plan weeks, starting the Monday after history ends */
  weeks: number
  paidHoursPerWeek: number
  /** Compounding week-over-week volume growth, fraction (0.002 = +0.2%/wk) */
  growthWeeklyPct: number
  /** Weekly overrides keyed by week Monday; absent weeks use the baseline */
  volumeOverrides: Map<string, number>
  ahtOverrides: Map<string, number>
  shrinkageByWeek: Map<string, number>
  defaultShrinkage: number
  /** Annual production attrition, fraction (0.3 = 30%/yr) */
  attritionAnnualPct: number
  /** Attrition applied across each class's training+nesting, fraction */
  trainingAttritionPct: number
  startingProductionHc: number
  /** Weeks for a graduate to ramp linearly from 50% to 100% productivity */
  rampWeeks: number
  hireClasses: HireClass[]
  /** Module 1 staffing engine config used for interval-true demand */
  staffing: StaffingConfig
}

export interface CapacityWeek {
  week: string
  volume: number
  aht: number
  /** Required productive FTE after shrinkage gross-up */
  requiredFte: number
  productionHc: number
  inTrainingHc: number
  /** Productive FTE supplied (ramp- and shrinkage-consistent with demand) */
  supplyFte: number
  overUnder: number
  /** Volume-weighted projected service level at the supplied staffing */
  projectedSl: number
}

export interface SolverConstraints {
  minClassSize: number
  maxClassSize: number
  maxClassesPerQuarter: number
  trainingWeeks: number
  nestingWeeks: number
  nestingProductivity: number
}

export interface CapacityPlan {
  queue: string
  weeks: CapacityWeek[]
  /** Baseline weekly volume before overrides, keyed by week Monday */
  seededBaseline: Map<string, number>
  solverSuggestions: HireClass[]
}
