import { CAPACITY_WEEKS, validateCapacityConfig } from '../engine/capacity'
import type { CapacityConfig, CapacityPlan } from '../engine/capacity'
import type { StaffingGridResult } from '../engine/staffing'
import { addDays, dayNumFromIso } from '../engine/series'

export type CapacityField = 'startingHeadcount' | 'weeklyAttritionPct' | 'paidHoursPerWeek' | 'shrinkagePct' | 'hourlyCost' | 'classSize' | 'startWeek' | 'trainingWeeks' | 'rampWeeks'
/** Strings preserve blank/invalid edits and are safe to round-trip in project JSON. */
export interface CapacityState {
  inputs: Record<CapacityField, string>
  demand: string[]
  sources: ('unset' | 'manual' | 'example' | 'forecast' | 'assumption')[]
  startDate: string | null
  seedPaidHours: number | null
}
export function emptyCapacityState(): CapacityState {
  return { inputs: { startingHeadcount: '100', weeklyAttritionPct: '0', paidHoursPerWeek: '40', shrinkagePct: '20', hourlyCost: '25', classSize: '0', startWeek: '2', trainingWeeks: '2', rampWeeks: '2' }, demand: Array(CAPACITY_WEEKS).fill(''), sources: Array(CAPACITY_WEEKS).fill('unset'), startDate: null, seedPaidHours: null }
}
export function exampleCapacityState(): CapacityState {
  const state = emptyCapacityState()
  state.inputs.classSize = '10'
  state.demand = Array.from({ length: CAPACITY_WEEKS }, (_, i) => i < 6 ? '78' : '84')
  state.sources.fill('example')
  return state
}
export function capacityConfig(state: CapacityState): CapacityConfig {
  const number = (value: string) => value.trim() === '' ? NaN : Number(value)
  const n = (field: CapacityField) => number(state.inputs[field])
  const config: CapacityConfig = { requiredProductiveFte: state.demand.map(number), startingHeadcount: n('startingHeadcount'), weeklyAttrition: n('weeklyAttritionPct') / 100, paidHoursPerWeek: n('paidHoursPerWeek'), shrinkage: n('shrinkagePct') / 100, hourlyCost: n('hourlyCost'), hiringClass: { size: n('classSize'), startWeek: n('startWeek'), trainingWeeks: n('trainingWeeks'), rampWeeks: n('rampWeeks') } }
  validateCapacityConfig(config)
  return config
}
/** Seven calendar days per week, including days with no open intervals. */
export function seedCapacityState(state: CapacityState, grid: StaffingGridResult, dates: readonly string[]): CapacityState {
  const hours = Number(state.inputs.paidHoursPerWeek)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('Paid hours per week must be greater than 0 and at most 168.')
  const completeWeeks = Math.min(CAPACITY_WEEKS, Math.floor(dates.length / 7))
  if (!completeWeeks || dates.some((d, i) => d !== addDays(dates[0], i))) throw new Error('Seeding needs at least seven consecutive forecast days.')
  const requirementHours = Array(completeWeeks).fill(0) as number[]
  for (const day of grid.daily) {
    const week = Math.floor((dayNumFromIso(day.date) - dayNumFromIso(dates[0])) / 7)
    if (week >= 0 && week < completeWeeks) requirementHours[week] += day.requiredFteHours
  }
  return { ...state, startDate: dates[0], seedPaidHours: hours,
    demand: Array.from({ length: CAPACITY_WEEKS }, (_, i) => String(requirementHours[Math.min(i, completeWeeks - 1)] / hours)),
    sources: Array.from({ length: CAPACITY_WEEKS }, (_, i) => i < completeWeeks ? 'forecast' : 'assumption') }
}
export function capacityCsv(plan: CapacityPlan, state: CapacityState): string {
  const header = 'week,start_date,demand_source,required_productive_fte,baseline_productive_fte,proposal_productive_fte,baseline_balance_fte,proposal_balance_fte,baseline_paid_cost,proposal_paid_cost,incremental_paid_cost'
  return [header, ...plan.weeks.map(w => [w.week, state.startDate ? addDays(state.startDate, (w.week - 1) * 7) : '', state.sources[w.week - 1], w.requiredProductiveFte, w.baseline.productiveFte, w.scenario.productiveFte, w.baseline.balanceFte, w.scenario.balanceFte, w.baseline.cost, w.scenario.cost, w.incrementalCost].join(','))].join('\n') + '\n'
}
