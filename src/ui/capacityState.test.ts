import { describe, expect, it } from 'vitest'
import { buildCapacityPlan } from '../engine/capacity'
import { addDays } from '../engine/series'
import { buildHistorySeed, firstPlanMonday, seedDemandFromHistory } from '../engine/capacitySeed'
import { applyScenario } from '../engine/staffing'
import type { IntervalRecord } from '../engine/types'
import { capacityConfig, capacityCsv, capacitySeedStaffing, classMilestones, emptyCapacityState, exampleCapacityState, seedCapacityState, seedCapacityStateFromHistory, seedGrowth } from './capacityState'

describe('capacity draft and forecast conversion', () => {
  it('keeps an uninitialized plan distinct from explicit zero demand', () => {
    const draft = emptyCapacityState()
    expect(() => capacityConfig(draft)).toThrow()
    draft.demand.fill('0')
    expect(buildCapacityPlan(capacityConfig(draft)).baseline.firstShortageWeek).toBeNull()
    draft.inputs.paidHoursPerWeek = '0'
    expect(() => capacityConfig(draft)).toThrow(/greater than 0/)
    draft.inputs.paidHoursPerWeek = ''
    expect(() => capacityConfig(draft)).toThrow()
  })
  it.each([7, 14, 28])('seeds %i days using required hours, repeating only the last full week', days => {
    const dates = Array.from({ length: days }, (_, i) => addDays('2026-09-07', i))
    const grid = { queue: 'voice', intervals: [], daily: dates.map((date, i) => ({ date, requiredFteHours: 40 * (1 + Math.floor(i / 7)), scheduledFteHours: 9999 })) }
    const state = seedCapacityState(emptyCapacityState(), grid, dates)
    expect(state.demand.slice(0, days / 7).map(Number)).toEqual(Array.from({ length: days / 7 }, (_, i) => 7 * (i + 1)))
    expect(Number(state.demand[12])).toBe(days)
    expect(state.sources.filter(s => s === 'forecast')).toHaveLength(days / 7)
    expect(state.sources[12]).toBe('assumption')
    expect(state.seedPaidHours).toBe(40)
    state.inputs.shrinkagePct = '50'
    expect(capacityConfig(state).requiredProductiveFte[0]).toBe(7)
    state.inputs.paidHoursPerWeek = '20'
    expect(capacityConfig(state).requiredProductiveFte[0]).toBe(7)
    expect(Number(seedCapacityState(state, grid, dates).demand[0])).toBe(14)
  })
  it('rejects invalid seed hours and incomplete calendar windows', () => {
    const state = emptyCapacityState()
    const grid = { queue: 'a', intervals: [], daily: [] }
    expect(() => seedCapacityState(state, grid, ['2026-01-01'])).toThrow(/seven/)
    state.inputs.paidHoursPerWeek = '0'
    expect(() => seedCapacityState(state, grid, [])).toThrow(/greater than 0/)
  })
  it('derives a 30-minute interval when seeded Mondays lack a half-hour slot', () => {
    const records: IntervalRecord[] = []
    for (let d = '2025-01-06'; d <= '2025-03-16'; d = addDays(d, 1)) {
      for (const t of ['08:00', '08:30', '09:00']) if (!(t === '08:30' && new Date(`${d}T00:00Z`).getUTCDay() === 1)) records.push({ ts: `${d}T${t}`, queue: 'voice', offered: 20, aht: 300 })
    }
    const seed = buildHistorySeed(records, 'voice', '2025-03-17', 0)
    expect(seed.intervalForecast.slice(0, 2).map(p => p.ts)).toEqual(['2025-03-17T08:00:00', '2025-03-17T09:00:00'])
    expect(capacitySeedStaffing('voice', seed.intervalForecast).config.intervalSec).toBe(1800)
  })
  it('seeds every plan week from 15-minute history with derived interval length and labels fallback weeks', () => {
    const records: IntervalRecord[] = []
    for (let d = '2025-01-06'; d <= '2025-03-16'; d = addDays(d, 1)) for (const t of ['08:00', '08:15', '08:30', '08:45']) records.push({ ts: `${d}T${t}`, queue: 'voice chat', offered: 20, aht: 600 })
    const state = emptyCapacityState()
    state.inputs.weeklyGrowthPct = '0.5'
    const seed = buildHistorySeed(records, 'voice chat', firstPlanMonday(records, 'voice chat'), seedGrowth(state))
    const { scenario, config } = capacitySeedStaffing('voice chat', seed.intervalForecast)
    expect(config.intervalSec).toBe(900)
    expect(scenario.chatConcurrency).toBe(2)
    const grid = applyScenario(seed.intervalForecast, scenario, config)
    const seeded = seedCapacityStateFromHistory(state, grid, seed)
    const direct = seedDemandFromHistory(records, 'voice chat', { planStart: '2025-03-17', weeklyGrowth: 0.005, paidHoursPerWeek: 40, scenario, config })
    expect(seeded.demand.map(Number)).toEqual(direct.requiredProductiveFte)
    const halfHour = seedDemandFromHistory(records, 'voice chat', { planStart: '2025-03-17', weeklyGrowth: 0.005, paidHoursPerWeek: 40, scenario, config: { ...config, intervalSec: 1800 } })
    expect(direct.requiredProductiveFte[0]).not.toBe(halfHour.requiredProductiveFte[0])
    expect(seeded.sources).toEqual(Array(13).fill('historyFallback'))
    expect(seeded).toMatchObject({ startDate: '2025-03-17', seedPaidHours: 40, seedGrowthPct: 0.5 })
    // Fallback weeks report no history holiday, so only plan weeks holding a holiday differ.
    expect(seeded.holidayMismatch).toEqual(seed.weeks.map(w => w.holidayInPlan))
    expect(seedCapacityStateFromHistory(seeded, grid, { ...seed, weeks: seed.weeks.map((w, i) => ({ ...w, holidayInHistory: i === 2, holidayInPlan: false })) }).holidayMismatch).toEqual(Array.from({ length: 13 }, (_, i) => i === 2))
    expect(seedCapacityStateFromHistory(seeded, grid, { ...seed, weeks: seed.weeks.map(w => ({ ...w, source: 'sameIsoWeek' as const })) }).sources).toEqual(Array(13).fill('history'))
    const reseeded = seedCapacityState({ ...seeded, holidayMismatch: Array(13).fill(true) }, { queue: 'a', intervals: [], daily: [] }, Array.from({ length: 7 }, (_, i) => addDays('2026-09-07', i)))
    expect(reseeded.seedGrowthPct).toBeNull()
    expect(reseeded.holidayMismatch).toEqual(Array(13).fill(false))
    state.inputs.weeklyGrowthPct = '5.5'
    expect(() => seedGrowth(state)).toThrow(/growth/)
    state.inputs.weeklyGrowthPct = ''
    expect(() => seedGrowth(state)).toThrow(/growth/)
  })
  it('maps every class draft and the new-hire rate into the engine config', () => {
    const state = exampleCapacityState()
    state.inputs.newHireAttritionPct = '2.5'
    state.classes.push({ size: '3', startWeek: '4', trainingWeeks: '1', nestingWeeks: '2', nestingProductivityPct: '40', rampWeeks: '0' })
    const config = capacityConfig(state)
    expect(config.newHireWeeklyAttrition).toBe(0.025)
    expect(config.hiringClasses).toEqual([{ size: 10, startWeek: 2, trainingWeeks: 2, nestingWeeks: 0, nestingProductivity: 0, rampWeeks: 2 }, { size: 3, startWeek: 4, trainingWeeks: 1, nestingWeeks: 2, nestingProductivity: 0.4, rampWeeks: 0 }])
    state.classes[1].nestingWeeks = ''
    expect(() => capacityConfig(state)).toThrow('hiringClasses[1].nestingWeeks')
    state.classes = []
    expect(capacityConfig(state).hiringClasses).toEqual([])
  })
  it('exports every engine value without rounding and round-trips the example draft', () => {
    const state = JSON.parse(JSON.stringify(exampleCapacityState()))
    const plan = buildCapacityPlan(capacityConfig(state))
    const rows = capacityCsv(plan, state).trim().split('\n').slice(1).map(r => r.split(','))
    expect(rows).toHaveLength(13)
    rows.forEach((r, i) => expect(r.slice(3).map(Number)).toEqual([plan.weeks[i].requiredProductiveFte, plan.weeks[i].baseline.productiveFte, plan.weeks[i].scenario.productiveFte, plan.weeks[i].baseline.balanceFte, plan.weeks[i].scenario.balanceFte, plan.weeks[i].baseline.cost, plan.weeks[i].scenario.cost, plan.weeks[i].incrementalCost]))
    expect(plan.baseline.firstShortageWeek).toBe(7)
    expect(plan.scenario.firstShortageWeek).toBeNull()
    expect(plan.baseline.totalCost).toBe(1300000)
    expect(plan.scenario.totalCost).toBe(1420000)
    expect(plan.incrementalCost).toBe(120000)
  })
  it('reads class start and production weeks from engine phases, skipping zero-size classes', () => {
    const state = exampleCapacityState()
    state.classes.push(
      { size: '0', startWeek: '3', trainingWeeks: '0', nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks: '0' },
      { size: '5', startWeek: '6', trainingWeeks: '1', nestingWeeks: '2', nestingProductivityPct: '50', rampWeeks: '3' },
      { size: '5', startWeek: '9', trainingWeeks: '0', nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks: '4' },
      { size: '5', startWeek: '12', trainingWeeks: '2', nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks: '0' })
    expect(classMilestones(buildCapacityPlan(capacityConfig(state)))).toEqual([
      { classNumber: 1, start: 2, production: 4 }, { classNumber: 3, start: 6, production: 9 },
      { classNumber: 4, start: 9, production: 9 }, { classNumber: 5, start: 12, production: null }])
  })
})
