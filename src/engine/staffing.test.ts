import { describe, expect, it } from 'vitest'
import type { ForecastPoint } from './types'
import { applyScenario, buildStaffingGrid, grossUp, projectAtStaffing } from './staffing'
import type { StaffingConfig } from './staffing'
import { requiredAgents } from './erlang'

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

describe('projectAtStaffing', () => {
  // Peak interval of the shared forecast: 360 calls * 240 s / 1800 s -> A = 48.
  const project = (mode: 'erlangC' | 'erlangA', n: number) =>
    projectAtStaffing(mode, 360, 240, 1800, 20, n, 120)

  it('zero volume: perfect SL, everything idle', () => {
    const p = projectAtStaffing('erlangC', 0, 240, 1800, 20, 10)
    expect(p).toEqual({ sl: 1, asa: 0, occupancy: 0, abandonPct: 0, unstable: false })
  })

  it('volume with no staff: SL 0, infinite ASA, saturated', () => {
    const c = project('erlangC', 0)
    expect(c.sl).toBe(0)
    expect(c.asa).toBe(Infinity)
    expect(c.occupancy).toBe(1)
    expect(c.abandonPct).toBe(0)
    expect(c.unstable).toBe(true)

    const a = project('erlangA', 0)
    expect(a.sl).toBe(0)
    expect(a.asa).toBe(Infinity)
    expect(a.abandonPct).toBe(1) // with patience, everyone eventually abandons
    expect(a.unstable).toBe(false)
  })

  it('Erlang C at N <= A is unstable: SL 0, occupancy clamped at 1', () => {
    const p = project('erlangC', 48) // N = A = 48
    expect(p.unstable).toBe(true)
    expect(p.sl).toBe(0)
    expect(p.asa).toBe(Infinity)
    expect(p.occupancy).toBe(1)
    expect(project('erlangC', 30).unstable).toBe(true)
    expect(project('erlangC', 49).unstable).toBe(false)
  })

  it('Erlang A stays stable below the offered load and sheds via abandonment', () => {
    const p = project('erlangA', 40) // below A = 48
    expect(p.unstable).toBe(false)
    expect(p.sl).toBeGreaterThan(0)
    expect(p.sl).toBeLessThan(0.8)
    expect(p.abandonPct).toBeGreaterThan(0.1)
    expect(p.occupancy).toBeLessThanOrEqual(1)
  })

  it('matches requiredAgents at the solved N and misses at N-1 (both modes)', () => {
    const target = { pct: 0.8, seconds: 20 }
    for (const mode of ['erlangC', 'erlangA'] as const) {
      const r = requiredAgents(mode, 360, 240, 1800, target, 120)
      const at = projectAtStaffing(mode, 360, 240, 1800, 20, r.bodies, 120)
      expect(at.sl).toBeCloseTo(r.sl, 12)
      expect(at.asa).toBeCloseTo(r.asa, 12)
      expect(at.abandonPct).toBeCloseTo(r.abandonPct, 12)
      expect(at.sl).toBeGreaterThanOrEqual(0.8)
      const below = projectAtStaffing(mode, 360, 240, 1800, 20, r.bodies - 1, 120)
      expect(below.sl).toBeLessThan(0.8)
    }
  })

  it('floors fractional agents', () => {
    expect(project('erlangC', 52.9)).toEqual(project('erlangC', 52))
  })
})

describe('fixed-staff grid', () => {
  const fixedConfig: StaffingConfig = { ...baseConfig, fixedScheduled: 20 }

  it('applies flat heads to open intervals only and projects metrics at them', () => {
    const grid = buildStaffingGrid(forecast, undefined, fixedConfig)
    const target = buildStaffingGrid(forecast, undefined, baseConfig)
    const [peak, offPeak, empty] = grid.intervals

    // Required (the target-needs reference) is untouched by fixed staffing.
    for (let i = 0; i < grid.intervals.length; i++) {
      expect(grid.intervals[i].required).toBe(target.intervals[i].required)
    }

    // Flat 20 heads on volume intervals, none on the closed one.
    expect(peak.scheduled).toBe(20)
    expect(offPeak.scheduled).toBe(20)
    expect(empty.scheduled).toBe(0)
    expect(empty.serviceLevel).toBe(1)

    // 20 heads at 30% shrinkage -> 14 bodies vs A = 48: swamped, flagged.
    expect(peak.serviceLevel).toBe(0)
    expect(peak.asa).toBe(Infinity)
    expect(peak.occupancy).toBe(1)
    expect(peak.unstable).toBe(true)

    // Metrics equal a direct projection at the same bodies.
    const p = projectAtStaffing('erlangC', 180, 240, 1800, 20, 20 * 0.7)
    expect(offPeak.serviceLevel).toBeCloseTo(p.sl, 12)
    expect(offPeak.asa).toBeCloseTo(p.asa, 12)
    expect(offPeak.occupancy).toBeCloseTo(p.occupancy, 12)
    expect(offPeak.unstable).toBe(p.unstable)

    // Daily scheduled FTE-hours reflect the flat heads.
    expect(grid.daily[0].scheduledFteHours).toBeCloseTo(20 * 0.5 * 2, 10)
  })

  it('erlangA fixed staffing reports abandonment instead of instability', () => {
    const grid = buildStaffingGrid(forecast.slice(0, 1), undefined, {
      ...fixedConfig,
      mode: 'erlangA',
    })
    const peak = grid.intervals[0]
    expect(peak.unstable).toBe(false)
    expect(peak.abandonRate).toBeGreaterThan(0.5) // 14 bodies vs A = 48
    expect(peak.serviceLevel).toBeLessThan(0.3)
  })

  it('applyScenario passes fixedScheduled through', () => {
    const viaScenario = applyScenario(forecast, { fixedScheduled: 20 }, baseConfig)
    const direct = buildStaffingGrid(forecast, undefined, fixedConfig)
    expect(viaScenario).toEqual(direct)
  })

  it('rejects a negative fixed staffing', () => {
    expect(() =>
      buildStaffingGrid(forecast, undefined, { ...baseConfig, fixedScheduled: -1 }),
    ).toThrow()
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

it('fixed projection rejects huge workloads and heads before recursion, preserving boundary service', () => {
  for (const mode of ['erlangC', 'erlangA'] as const) {
    expect(() => projectAtStaffing(mode, 60, 300, 1800, 20, 10000000000, 120)).toThrow('2000 on-contact')
    expect(() => projectAtStaffing(mode, 6000.01, 300, 1800, 20, 100, 120)).toThrow('1000 Erlangs')
    const r = projectAtStaffing(mode, 6000, 300, 1800, 20, 2000, 120)
    expect(r.sl).toBeCloseTo(1, 10)
    expect(r.occupancy).toBeCloseTo(.5, 10)
  }
})
