import type { ErlangMode } from '../../engine/erlang'
import type { StaffingConfig } from '../../engine/staffing'
import type {
  CapacityAssumptions,
  HireClass,
  SolverConstraints,
} from '../../engine/capacityTypes'

/**
 * UI state for the capacity tab. Sliders hold whole percents (30 = 30%);
 * conversion to engine fractions happens in buildAssumptions.
 */

export interface ClassDefaults {
  trainingWeeks: number
  nestingWeeks: number
  nestingProductivityPct: number
  minClassSize: number
  maxClassSize: number
  maxClassesPerQuarter: number
}

export const DEFAULT_CLASS_DEFAULTS: ClassDefaults = {
  trainingWeeks: 6,
  nestingWeeks: 4,
  nestingProductivityPct: 50,
  minClassSize: 5,
  maxClassSize: 30,
  maxClassesPerQuarter: 2,
}

export interface CapacityStaffingState {
  mode: ErlangMode
  slPct: number
  slSeconds: number
  patienceSec: number
  occupancyCapPct: number
}

export const DEFAULT_CAPACITY_STAFFING: CapacityStaffingState = {
  mode: 'erlangA',
  slPct: 80,
  slSeconds: 20,
  patienceSec: 120,
  occupancyCapPct: 90,
}

export interface CapacityRailState {
  weeks: number
  startingHc: number
  paidHours: number
  /** Weekly growth in whole percent, e.g. 0.2 = +0.2%/week */
  growthPct: number
  attritionPct: number
  shrinkagePct: number
  rampWeeks: number
}

export const DEFAULT_RAIL: CapacityRailState = {
  weeks: 52,
  startingHc: 100,
  paidHours: 40,
  growthPct: 0.2,
  attritionPct: 30,
  shrinkagePct: 30,
  rampWeeks: 8,
}

export type ScenarioId = 'base' | 'upside' | 'downside'

export interface ScenarioOverrideState {
  growthPct: number
  attritionPct: number
  shrinkagePct: number
  ahtDeltaPct: number
}

export const DEFAULT_SCENARIO_OVERRIDES: Record<'upside' | 'downside', ScenarioOverrideState> = {
  upside: { growthPct: 0, attritionPct: 25, shrinkagePct: 28, ahtDeltaPct: -5 },
  downside: { growthPct: 0.5, attritionPct: 40, shrinkagePct: 35, ahtDeltaPct: 5 },
}

/** In-training attrition per class, engine default (design doc). */
export const TRAINING_ATTRITION = 0.1

export function buildAssumptions(
  queue: string,
  rail: CapacityRailState,
  staffing: CapacityStaffingState,
  isChatQueue: boolean,
  volumeOverrides: Map<string, number>,
  ahtOverrides: Map<string, number>,
  shrinkageByWeek: Map<string, number>,
  hireClasses: HireClass[],
): CapacityAssumptions {
  const staffingConfig: StaffingConfig = {
    mode: staffing.mode,
    slPct: staffing.slPct / 100,
    slSeconds: staffing.slSeconds,
    patienceSec: staffing.patienceSec,
    shrinkage: rail.shrinkagePct / 100,
    occupancyCap: staffing.occupancyCapPct / 100,
    intervalSec: 1800,
    chatConcurrency: isChatQueue ? 2 : 1,
    queue,
  }
  return {
    queue,
    weeks: rail.weeks,
    paidHoursPerWeek: rail.paidHours,
    growthWeeklyPct: rail.growthPct / 100,
    volumeOverrides,
    ahtOverrides,
    shrinkageByWeek,
    defaultShrinkage: rail.shrinkagePct / 100,
    attritionAnnualPct: rail.attritionPct / 100,
    trainingAttritionPct: TRAINING_ATTRITION,
    startingProductionHc: rail.startingHc,
    rampWeeks: rail.rampWeeks,
    hireClasses,
    staffing: staffingConfig,
  }
}

export function toConstraints(d: ClassDefaults): SolverConstraints {
  return {
    minClassSize: d.minClassSize,
    maxClassSize: d.maxClassSize,
    maxClassesPerQuarter: d.maxClassesPerQuarter,
    trainingWeeks: d.trainingWeeks,
    nestingWeeks: d.nestingWeeks,
    nestingProductivity: d.nestingProductivityPct / 100,
  }
}

/** Stable cache key for a full assumptions object (Maps serialized sorted). */
export function assumptionsKey(a: CapacityAssumptions): string {
  const mapKey = (m: Map<string, number>) =>
    [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).flat().join(',')
  return JSON.stringify({
    q: a.queue,
    w: a.weeks,
    ph: a.paidHoursPerWeek,
    g: a.growthWeeklyPct,
    vo: mapKey(a.volumeOverrides),
    ao: mapKey(a.ahtOverrides),
    so: mapKey(a.shrinkageByWeek),
    ds: a.defaultShrinkage,
    at: a.attritionAnnualPct,
    ta: a.trainingAttritionPct,
    hc: a.startingProductionHc,
    rw: a.rampWeeks,
    cl: a.hireClasses.map((c) => [c.startWeek, c.size, c.trainingWeeks, c.nestingWeeks, c.nestingProductivity]),
    st: [
      a.staffing.mode,
      a.staffing.slPct,
      a.staffing.slSeconds,
      a.staffing.patienceSec,
      a.staffing.occupancyCap,
      a.staffing.chatConcurrency,
      a.staffing.intervalSec,
      a.staffing.shrinkage,
      a.staffing.maxAbandonPct,
    ],
  })
}
