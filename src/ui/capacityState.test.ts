import { describe, expect, it } from 'vitest'
import { buildCapacityPlan } from '../engine/capacity'
import { addDays } from '../engine/series'
import { capacityConfig, capacityCsv, emptyCapacityState, exampleCapacityState, seedCapacityState } from './capacityState'

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
})
