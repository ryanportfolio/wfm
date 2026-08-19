import { describe, expect, it } from 'vitest'
import type { ForecastPoint } from './types'
import { applyScenario, buildStaffingGrid, grossUp } from './staffing'
import type { StaffingConfig } from './staffing'

const baseConfig: StaffingConfig = {
  mode: 'erlangC',
  slPct: 0.8,
  slSeconds: 20,
  patienceSec: 90,
  shrinkage: 0.3,
  intervalSec: 1800,
  queue: 'voice',
}

const forecast: ForecastPoint[] = [
  { ts: '2026-08-17T09:00:00', offered: 360, aht: 240 },
  { ts: '2026-08-17T09:30:00', offered: 180, aht: 240 },
  { ts: '2026-08-17T10:00:00', offered: 0, aht: 0 },
  { ts: '2026-08-18T09:00:00', offered: 90, aht: 300 },
]

describe('grossUp', () => {
  it('divides, never multiplies: 70 bodies at 30% shrinkage -> 100 scheduled', () => {
    expect(grossUp(70, 0.3)).toBeCloseTo(100, 10)
  })

  it('rejects shrinkage outside [0, 1)', () => {
    expect(() => grossUp(10, 1)).toThrow()
    expect(() => grossUp(10, 1.2)).toThrow()
    expect(() => grossUp(10, -0.1)).toThrow()
  })
})

describe('buildStaffingGrid', () => {
  it('produces a sane grid on a small synthetic forecast', () => {
    const grid = buildStaffingGrid(forecast, undefined, baseConfig)
    expect(grid.queue).toBe('voice')
    expect(grid.intervals).toHaveLength(4)

    const [peak, offPeak, empty, day2] = grid.intervals
    // Peak interval: A = 48, so requirement clears the load and meets SL.
    expect(peak.required).toBeGreaterThan(48)
    expect(peak.serviceLevel).toBeGreaterThanOrEqual(0.8)
    expect(peak.occupancy).toBeGreaterThan(0)
    expect(peak.occupancy).toBeLessThan(1)
    expect(peak.abandonRate).toBe(0) // erlangC mode
    expect(peak.queue).toBe('voice')

    // Fewer calls, fewer agents.
    expect(offPeak.required).toBeLessThan(peak.required)
    expect(offPeak.required).toBeGreaterThan(24) // A = 24

    // Zero-volume interval needs nobody.
    expect(empty.required).toBe(0)
    expect(empty.scheduled).toBe(0)
    expect(empty.serviceLevel).toBe(1)
    expect(empty.occupancy).toBe(0)

    expect(day2.required).toBeGreaterThan(15) // A = 15

    // Shrinkage gross-up on every interval.
    for (const iv of grid.intervals) {
      expect(iv.scheduled).toBeCloseTo(iv.required / 0.7, 10)
    }
  })

  it('sums daily FTE-hours per date', () => {
    const grid = buildStaffingGrid(forecast, undefined, baseConfig)
    expect(grid.daily.map((d) => d.date)).toEqual(['2026-08-17', '2026-08-18'])
    const [d1, d2] = grid.daily
    const day1 = grid.intervals.slice(0, 3)
    expect(d1.requiredFteHours).toBeCloseTo(day1.reduce((s, iv) => s + iv.required * 0.5, 0), 10)
    expect(d1.scheduledFteHours).toBeCloseTo(day1.reduce((s, iv) => s + iv.scheduled * 0.5, 0), 10)
    expect(d2.requiredFteHours).toBeCloseTo(grid.intervals[3].required * 0.5, 10)
  })

  it('applies an explicit AHT forecast over the point AHT', () => {
    const doubled = buildStaffingGrid(forecast.slice(0, 1), [480], baseConfig)
    const base = buildStaffingGrid(forecast.slice(0, 1), undefined, baseConfig)
    expect(doubled.intervals[0].required).toBeGreaterThan(base.intervals[0].required)
  })

  it('chat concurrency reduces the requirement', () => {
    const chat = buildStaffingGrid(forecast.slice(0, 1), undefined, {
      ...baseConfig,
      chatConcurrency: 2,
    })
    const voice = buildStaffingGrid(forecast.slice(0, 1), undefined, baseConfig)
    expect(chat.intervals[0].required).toBeLessThan(voice.intervals[0].required)
  })

  it('works in erlangA mode with an abandonment cap', () => {
    const grid = buildStaffingGrid(forecast, undefined, {
      ...baseConfig,
      mode: 'erlangA',
      maxAbandonPct: 0.03,
    })
    const peak = grid.intervals[0]
    expect(peak.serviceLevel).toBeGreaterThanOrEqual(0.8)
    expect(peak.abandonRate).toBeGreaterThan(0)
    expect(peak.abandonRate).toBeLessThanOrEqual(0.03)
  })

  it('rejects shrinkage >= 1', () => {
    expect(() => buildStaffingGrid(forecast, undefined, { ...baseConfig, shrinkage: 1 })).toThrow()
  })
})

describe('applyScenario', () => {
  it('with no deltas reproduces the base grid', () => {
    const base = buildStaffingGrid(forecast, undefined, baseConfig)
    const same = applyScenario(forecast, {}, baseConfig)
    expect(same).toEqual(base)
  })

  it('volume +30% raises requirements, AHT -20% lowers them', () => {
    const base = buildStaffingGrid(forecast, undefined, baseConfig)
    const up = applyScenario(forecast, { volumeDeltaPct: 30 }, baseConfig)
    const down = applyScenario(forecast, { ahtDeltaPct: -20 }, baseConfig)
    for (let i = 0; i < forecast.length; i++) {
      expect(up.intervals[i].required).toBeGreaterThanOrEqual(base.intervals[i].required)
      expect(down.intervals[i].required).toBeLessThanOrEqual(base.intervals[i].required)
    }
    expect(up.intervals[0].required).toBeGreaterThan(base.intervals[0].required)
    expect(down.intervals[0].required).toBeLessThan(base.intervals[0].required)
  })

  it('overrides config levers (shrinkage) without touching requirements', () => {
    const base = buildStaffingGrid(forecast, undefined, baseConfig)
    const lean = applyScenario(forecast, { shrinkage: 0 }, baseConfig)
    for (let i = 0; i < forecast.length; i++) {
      expect(lean.intervals[i].required).toBe(base.intervals[i].required)
      expect(lean.intervals[i].scheduled).toBe(lean.intervals[i].required)
    }
  })

  it('is pure: inputs are not mutated', () => {
    const pointsCopy = forecast.map((p) => ({ ...p }))
    const configCopy = { ...baseConfig }
    applyScenario(forecast, { volumeDeltaPct: 30, ahtDeltaPct: 10, shrinkage: 0.4 }, baseConfig)
    expect(forecast).toEqual(pointsCopy)
    expect(baseConfig).toEqual(configCopy)
  })
})
