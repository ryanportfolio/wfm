import { CAPACITY_WEEKS, validateCapacityConfig } from '../engine/capacity'
import type { CapacityConfig, CapacityPlan } from '../engine/capacity'
import type { Scenario, StaffingConfig, StaffingGridResult } from '../engine/staffing'
import type { ForecastPoint } from '../engine/types'
import type { HistorySeed } from '../engine/capacitySeed'
import { HISTORY_SEED_MAX_WEEKLY_GROWTH, weeklyRequirementHours } from '../engine/capacitySeed'
import { addDays } from '../engine/series'
import { DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'
import { deriveIntervalSec } from './staffingInterval'

export type CapacityField = 'startingHeadcount' | 'weeklyAttritionPct' | 'newHireAttritionPct' | 'paidHoursPerWeek' | 'shrinkagePct' | 'hourlyCost' | 'weeklyGrowthPct'
export type HiringClassField = 'size' | 'startWeek' | 'trainingWeeks' | 'nestingWeeks' | 'nestingProductivityPct' | 'rampWeeks'
export type CapacitySource = 'unset' | 'manual' | 'example' | 'forecast' | 'assumption' | 'history' | 'historyFallback'
export const CAPACITY_SOURCES: readonly CapacitySource[] = ['unset', 'manual', 'example', 'forecast', 'assumption', 'history', 'historyFallback']
/** Strings preserve blank/invalid edits and are safe to round-trip in project JSON. */
export interface CapacityState {
  /** weeklyGrowthPct is the history-seed growth draft; it does not enter the plan until a seed runs. */
  inputs: Record<CapacityField, string>
  classes: Record<HiringClassField, string>[]
  demand: string[]
  sources: CapacitySource[]
  startDate: string | null
  seedPaidHours: number | null
  /** Weekly growth percent used by the last history seed. */
  seedGrowthPct: number | null
  /** Per week: the history seed's holiday flags differ (history vs plan week). False for every other source. */
  holidayMismatch: boolean[]
}
export function emptyHiringClass(): Record<HiringClassField, string> {
  return { size: '0', startWeek: '2', trainingWeeks: '2', nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks: '2' }
}
export function emptyCapacityState(): CapacityState {
  return { inputs: { startingHeadcount: '100', weeklyAttritionPct: '0', newHireAttritionPct: '0', paidHoursPerWeek: '40', shrinkagePct: '20', hourlyCost: '25', weeklyGrowthPct: '0' }, classes: [emptyHiringClass()], demand: Array(CAPACITY_WEEKS).fill(''), sources: Array(CAPACITY_WEEKS).fill('unset'), startDate: null, seedPaidHours: null, seedGrowthPct: null, holidayMismatch: Array(CAPACITY_WEEKS).fill(false) }
}
export function exampleCapacityState(): CapacityState {
  const state = emptyCapacityState()
  state.classes[0].size = '10'
  state.demand = Array.from({ length: CAPACITY_WEEKS }, (_, i) => i < 6 ? '78' : '84')
  state.sources.fill('example')
  return state
}
const number = (value: string) => value.trim() === '' ? NaN : Number(value)
export function capacityConfig(state: CapacityState): CapacityConfig {
  const n = (field: CapacityField) => number(state.inputs[field])
  const config: CapacityConfig = { requiredProductiveFte: state.demand.map(number), startingHeadcount: n('startingHeadcount'), weeklyAttrition: n('weeklyAttritionPct') / 100, newHireWeeklyAttrition: n('newHireAttritionPct') / 100, paidHoursPerWeek: n('paidHoursPerWeek'), shrinkage: n('shrinkagePct') / 100, hourlyCost: n('hourlyCost'),
    hiringClasses: state.classes.map(c => ({ size: number(c.size), startWeek: number(c.startWeek), trainingWeeks: number(c.trainingWeeks), nestingWeeks: number(c.nestingWeeks), nestingProductivity: number(c.nestingProductivityPct) / 100, rampWeeks: number(c.rampWeeks) })) }
  validateCapacityConfig(config)
  return config
}
/** Weekly growth draft as a fraction; throws outside the history-seed bound. */
export function seedGrowth(state: CapacityState): number {
  const pct = number(state.inputs.weeklyGrowthPct)
  if (!Number.isFinite(pct) || Math.abs(pct) > HISTORY_SEED_MAX_WEEKLY_GROWTH * 100) throw new Error(`Weekly growth must be from -${HISTORY_SEED_MAX_WEEKLY_GROWTH * 100}% to ${HISTORY_SEED_MAX_WEEKLY_GROWTH * 100}%.`)
  return pct / 100
}
/** Default staffing targets shared by forecast and history seeds; interval length comes from the points. */
export function capacitySeedStaffing(queue: string, points: readonly ForecastPoint[]): { scenario: Scenario; config: StaffingConfig } {
  return { scenario: toEngineScenario(DEFAULT_SCENARIO, queue.toLowerCase().includes('chat')),
    config: { mode: 'erlangA', slPct: 0.8, slSeconds: 20, patienceSec: 120, shrinkage: 0.3, intervalSec: deriveIntervalSec(points), queue } }
}
function seedHours(state: CapacityState): number {
  const hours = Number(state.inputs.paidHoursPerWeek)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('Paid hours per week must be greater than 0 and at most 168.')
  return hours
}
/** Seven calendar days per week, including days with no open intervals. */
export function seedCapacityState(state: CapacityState, grid: StaffingGridResult, dates: readonly string[]): CapacityState {
  const hours = seedHours(state)
  const completeWeeks = Math.min(CAPACITY_WEEKS, Math.floor(dates.length / 7))
  if (!completeWeeks || dates.some((d, i) => d !== addDays(dates[0], i))) throw new Error('Seeding needs at least seven consecutive forecast days.')
  const requirementHours = weeklyRequirementHours(grid.daily, dates[0], completeWeeks)
  return { ...state, startDate: dates[0], seedPaidHours: hours, seedGrowthPct: null, holidayMismatch: Array(CAPACITY_WEEKS).fill(false),
    demand: Array.from({ length: CAPACITY_WEEKS }, (_, i) => String(requirementHours[Math.min(i, completeWeeks - 1)] / hours)),
    sources: Array.from({ length: CAPACITY_WEEKS }, (_, i) => i < completeWeeks ? 'forecast' : 'assumption') }
}
/** grid must staff seed.intervalForecast; every plan week is a seeded week. */
export function seedCapacityStateFromHistory(state: CapacityState, grid: StaffingGridResult, seed: HistorySeed): CapacityState {
  const hours = seedHours(state)
  const requirementHours = weeklyRequirementHours(grid.daily, seed.planStart, CAPACITY_WEEKS)
  return { ...state, startDate: seed.planStart, seedPaidHours: hours, seedGrowthPct: seed.weeklyGrowth * 100,
    holidayMismatch: seed.weeks.map(w => w.holidayInHistory !== w.holidayInPlan),
    demand: requirementHours.map(h => String(h / hours)),
    sources: seed.weeks.map(w => w.source === 'sameIsoWeek' ? 'history' : 'historyFallback') }
}
export interface ClassMilestone {
  /** 1-based position in the class list */
  classNumber: number
  /** Arrival (start) week */
  start: number
  /** First week after training and nesting; null when that falls after week 13. */
  production: number | null
}
/** Start and production weeks read from the engine's per-week phases; zero-size classes are skipped. */
export function classMilestones(plan: CapacityPlan): ClassMilestone[] {
  const milestones: ClassMilestone[] = []
  for (let i = 0; i < (plan.weeks[0]?.classes.length ?? 0); i++) {
    const start = plan.weeks.find(w => w.classes[i].phase !== 'pending' && w.classes[i].headcount > 0)
    if (!start) continue
    const production = plan.weeks.find(w => w.classes[i].phase === 'ramp' || w.classes[i].phase === 'productive')
    milestones.push({ classNumber: i + 1, start: start.week, production: production?.week ?? null })
  }
  return milestones
}
export function capacityCsv(plan: CapacityPlan, state: CapacityState): string {
  const header = 'week,start_date,demand_source,required_productive_fte,baseline_productive_fte,proposal_productive_fte,baseline_balance_fte,proposal_balance_fte,baseline_paid_cost,proposal_paid_cost,incremental_paid_cost'
  return [header, ...plan.weeks.map(w => [w.week, state.startDate ? addDays(state.startDate, (w.week - 1) * 7) : '', state.sources[w.week - 1], w.requiredProductiveFte, w.baseline.productiveFte, w.scenario.productiveFte, w.baseline.balanceFte, w.scenario.balanceFte, w.baseline.cost, w.scenario.cost, w.incrementalCost].join(','))].join('\n') + '\n'
}
