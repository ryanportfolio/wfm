import { describe, expect, it } from 'vitest'
import { calculateIntraday, intradayCsv, reforecastDay } from './intraday'
import { buildStaffingGrid, projectAtStaffing } from './staffing'
import type { StaffingConfig } from './staffing'

export const day = [{ ts: '2026-01-06T08:00:00', offered: 100, aht: 300 }, { ts: '2026-01-06T08:30:00', offered: 200, aht: 300 }]
export const inputs = { cutoff: 1, actuals: { [day[0].ts]: '120', [day[1].ts]: '99999' }, scheduled: { [day[0].ts]: '30', [day[1].ts]: '0' } }
export const config: StaffingConfig = { mode: 'erlangC', slPct: .8, slSeconds: 20, patienceSec: 120, shrinkage: .3, intervalSec: 1800, chatConcurrency: 1, occupancyCap: .9 }

describe('intraday reforecast', () => {
  it('100 baseline ->120 actual, remaining200 ->240, full day360 without future actual leakage', () => {
    const r = calculateIntraday(day, inputs, config)
    expect(r.ratio).toBe(1.2); expect(r.revisedTotal).toBe(360)
    expect(r.rows.map(p => p.revised)).toEqual([120, 240])
    expect(r.observedBaseline).toBe(100); expect(r.observedActual).toBe(120)
    expect(intradayCsv(r)).toContain('2026-01-06T08:30:00,remaining,200.0,240.0,0,')
  })
  it('blank is incomplete; zero is a complete observation', () => {
    expect(() => reforecastDay(day, { ...inputs, actuals: {} })).toThrow('missing')
    expect(reforecastDay(day, { ...inputs, actuals: { [day[0].ts]: '0' } }).revisedTotal).toBe(0)
  })
  it('no elapsed intervals ignores all stored actuals, including invalid future drafts', () => {
    const r = reforecastDay(day, { ...inputs, cutoff: 0, actuals: { [day[0].ts]: 'invalid' } })
    expect(r.ratio).toBeNull(); expect(r.revisedTotal).toBe(300)
  })
  it('zero observed baseline retains remaining baseline and counts actuals', () => {
    const r = reforecastDay([{ ...day[0], offered: 0 }, day[1]], inputs)
    expect(r.ratio).toBeNull(); expect(r.revisedTotal).toBe(320)
  })
  it('fully observed day is the sum of actuals', () => {
    expect(reforecastDay(day, { ...inputs, cutoff: 2, actuals: { [day[0].ts]: '120', [day[1].ts]: '180' } }).revisedTotal).toBe(300)
  })
  it('uses existing Erlang need and projects per-interval staffing with shrinkage once and concurrency', () => {
    for (const mode of ['erlangC', 'erlangA'] as const) {
      const c = { ...config, mode, chatConcurrency: 2 }
      const r = calculateIntraday(day, inputs, c)
      expect(r.rows[0].baselineRequired).toBe(buildStaffingGrid(day, undefined, c).intervals[0].required)
      expect(r.rows[0].revisedSl).toBe(projectAtStaffing(mode, 120, 150, 1800, 20, 21, 120).sl)
      expect(r.rows[1].revisedSl).toBe(0)
      expect(r.rows[0].revisedSl).toBeGreaterThan(r.rows[1].revisedSl)
    }
  })
  it('zero day and empty day are safe; positive actuals at AHT0 fail explicitly', () => {
    const zero = day.map(p => ({ ...p, offered: 0, aht: 0 }))
    const r = calculateIntraday(zero, { ...inputs, cutoff: 0 }, config)
    expect(r.rows[0].baselineRequired).toBe(0); expect(r.rows[0].baselineSl).toBe(1)
    expect(calculateIntraday([], { cutoff: 0, actuals: {}, scheduled: {} }, config).revisedTotal).toBe(0)
    expect(() => calculateIntraday(zero, inputs, config)).toThrow('AHT')
  })
  it.each([-1, 1.5, 3, Infinity])('rejects invalid cutoff %s', cutoff => {
    expect(() => reforecastDay(day, { ...inputs, cutoff })).toThrow()
  })
  it.each(['-1', 'NaN', '1e309', '100001'])('rejects invalid actual %s', actual => {
    expect(() => calculateIntraday(day, { ...inputs, actuals: { [day[0].ts]: actual } }, config)).toThrow()
  })
  it('rejects huge workload and invalid staffing before queue solves', () => {
    expect(() => calculateIntraday([day[0], { ...day[1], ts: '2026-01-06T08:15:00' }], { ...inputs, cutoff: 0 }, config)).toThrow('half-hour')
    expect(() => calculateIntraday(day.map(p => ({ ...p, offered: 100000 })), { ...inputs, cutoff: 0 }, config)).toThrow('100 Erlangs')
    expect(() => calculateIntraday(day, { ...inputs, scheduled: { [day[0].ts]: '501' } }, config)).toThrow('500')
    expect(() => calculateIntraday(day, { ...inputs, scheduled: { [day[0].ts]: '' } }, config)).toThrow('missing')
    expect(() => calculateIntraday(day, inputs, { ...config, slPct: 1 })).toThrow('assumptions')
  })
})

it('CSV preserves fractional scheduled heads across the whole-body shrinkage boundary', () => {
  const points = [{ ...day[0], offered: 60 }]
  const r = calculateIntraday(points, { cutoff: 0, actuals: {}, scheduled: { [day[0].ts]: '17.1429' } }, config)
  const csvHeads = Number(intradayCsv(r).split('\n')[1].split(',')[4])
  expect(csvHeads).toBe(17.1429)
  expect(Math.floor(csvHeads * .7)).toBe(12)
  expect(r.rows[0].baselineSl).toBeCloseTo(.6070, 3)
  expect(projectAtStaffing('erlangC', 60, 300, 1800, 20, csvHeads * .7).sl).toBe(r.rows[0].baselineSl)
  expect(projectAtStaffing('erlangC', 60, 300, 1800, 20, 17.1 * .7).sl).toBeLessThan(.37)
})
