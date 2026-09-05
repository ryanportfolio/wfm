import { describe, expect, it } from 'vitest'
import { asa, erlangA, erlangB, erlangC, occupancy, requiredAgents, serviceLevel } from './erlang'

/**
 * Independent cross-check implementations, deliberately different from the
 * production code path: direct term sums in log space instead of the
 * B(k) recursion.
 */
function lnFactorial(n: number): number {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

/** Erlang B via direct sum: B = (A^N/N!) / sum_{k=0..N} A^k/k!, in log space. */
function erlangBDirect(A: number, N: number): number {
  const lnA = Math.log(A)
  const logTerms: number[] = []
  for (let k = 0; k <= N; k++) logTerms.push(k * lnA - lnFactorial(k))
  const m = Math.max(...logTerms)
  const denom = logTerms.reduce((acc, lt) => acc + Math.exp(lt - m), 0)
  return Math.exp(logTerms[N] - m) / denom
}

/** Erlang C via direct sum: C = (A^N/N!)(N/(N-A)) / (sum_{k<N} A^k/k! + same). */
function erlangCDirect(A: number, N: number): number {
  const lnA = Math.log(A)
  const logTerms: number[] = []
  for (let k = 0; k < N; k++) logTerms.push(k * lnA - lnFactorial(k))
  const logTop = N * lnA - lnFactorial(N) + Math.log(N / (N - A))
  const m = Math.max(logTop, ...logTerms)
  const denom = logTerms.reduce((acc, lt) => acc + Math.exp(lt - m), Math.exp(logTop - m))
  return Math.exp(logTop - m) / denom
}

describe('erlangB', () => {
  it('matches published Erlang B table values', () => {
    // Standard Erlang B loss table checkpoints (blocking probability).
    expect(erlangB(2, 5)).toBeCloseTo(0.0367, 4) // A=2E, 5 trunks -> 3.67%
    expect(erlangB(10, 14)).toBeCloseTo(0.0568, 4) // A=10E, 14 trunks -> 5.68%
    expect(erlangB(5, 10)).toBeCloseTo(0.0184, 4) // A=5E, 10 trunks -> 1.84%
    expect(erlangB(1, 1)).toBeCloseTo(0.5, 12) // classic single-trunk case
  })

  it('agrees with an independent direct-sum computation', () => {
    for (const [A, N] of [
      [2, 5],
      [10, 14],
      [48, 55],
      [0.5, 3],
      [30, 30],
    ] as const) {
      expect(erlangB(A, N)).toBeCloseTo(erlangBDirect(A, N), 10)
    }
  })

  it('handles edge inputs', () => {
    expect(erlangB(0, 5)).toBe(0)
    expect(erlangB(4, 0)).toBe(1) // no trunks: everything blocked
  })
})

describe('erlangC', () => {
  // The classic sizing example: 360 calls per half hour, AHT 240 s
  // -> A = 360 * 240 / 1800 = 48 erlangs.
  it('matches the 360-calls/half-hour checkpoint, verified by independent recursion', () => {
    const A = (360 * 240) / 1800
    expect(A).toBe(48)
    // Independent direct-sum computation pins the exact values.
    expect(erlangC(48, 55)).toBeCloseTo(erlangCDirect(48, 55), 10)
    expect(erlangC(48, 55)).toBeCloseTo(0.23870, 4) // P(wait) 23.87%
    expect(serviceLevel(48, 55, 240, 20)).toBeCloseTo(0.8668, 3) // 86.7% in 20 s
    expect(asa(48, 55, 240)).toBeCloseTo(8.184, 2) // seconds
    // First N meeting 80/20 for this load is 54 (SL 81.7%); see requiredAgents test.
  })

  it('matches a hand-recursed A=10, N=12 checkpoint', () => {
    // Hand recursion: B(10,12) = 0.119741; C = 12B/(12 - 10(1-B)) = 0.44939.
    expect(erlangC(10, 12)).toBeCloseTo(0.44939, 4)
    expect(erlangC(10, 12)).toBeCloseTo(erlangCDirect(10, 12), 10)
    expect(serviceLevel(10, 12, 300, 30)).toBeCloseTo(0.63207, 4)
  })

  it('treats N <= A as unstable', () => {
    expect(erlangC(10, 10)).toBe(1)
    expect(serviceLevel(10, 9, 300, 30)).toBe(0)
    expect(asa(10, 10, 300)).toBe(Infinity)
  })

  it('occupancy is A/N', () => {
    expect(occupancy(48, 55)).toBeCloseTo(48 / 55, 12)
  })
})

describe('monotonicity', () => {
  const A = 48
  const aht = 240
  const t = 20

  it('erlangC SL increases and ASA decreases with N', () => {
    for (let N = 50; N < 70; N++) {
      expect(serviceLevel(A, N + 1, aht, t)).toBeGreaterThan(serviceLevel(A, N, aht, t))
      expect(asa(A, N + 1, aht)).toBeLessThan(asa(A, N, aht))
    }
  })

  it('erlangA SL increases and abandonment decreases with N', () => {
    const patience = 90
    for (let N = 44; N < 60; N++) {
      const lo = erlangA(A, N, aht, patience, t)
      const hi = erlangA(A, N + 1, aht, patience, t)
      expect(hi.serviceLevel).toBeGreaterThan(lo.serviceLevel)
      expect(hi.abandonProb).toBeLessThan(lo.abandonProb)
    }
  })

  it('erlangA SL >= erlangC SL at the same A, N (abandonment thins the queue)', () => {
    for (const [a, n, ahtSec] of [
      [48, 55, 240],
      [48, 50, 240],
      [10, 12, 300],
      [20, 22, 300],
    ] as const) {
      const ea = erlangA(a, n, ahtSec, 90, t)
      expect(ea.serviceLevel).toBeGreaterThanOrEqual(serviceLevel(a, n, ahtSec, t))
    }
  })

  it('erlangA converges to erlangC as patience grows very large', () => {
    const ea = erlangA(48, 55, 240, 1e7, 20)
    expect(Math.abs(ea.serviceLevel - serviceLevel(48, 55, 240, 20))).toBeLessThan(0.005) // 0.5 pp
    expect(Math.abs(ea.pWait - erlangC(48, 55))).toBeLessThan(0.001)
    expect(Math.abs(ea.asa - asa(48, 55, 240))).toBeLessThan(0.05)
    expect(ea.abandonProb).toBeLessThan(1e-4)
  })
})

describe('erlangA', () => {
  it('bounds costly uniformization for tiny AHT, long targets and overflowing estimates', () => {
    expect(() => erlangA(1e-8 / 1800, 1, 1e-8, 120, 20)).toThrow('Check AHT, patience and answer target in seconds')
    // Many phases matter even when the step count alone is modest.
    expect(() => erlangA(10, 10, 1, 1e7, 1000)).toThrow('supported workload')
    expect(() => erlangA(.5, 1, .01, 1e308, 1e308)).toThrow('supported workload')
    expect(() => erlangA(.5, 1, Number.MIN_VALUE, 120, 20)).toThrow('supported workload')
    expect(() => erlangA(1, Infinity, 300, 120, 20)).toThrow('2000 on-contact')
    expect(() => erlangA(Infinity, 1, 300, 120, 20)).toThrow('1000 Erlangs')
  })

  it('preserves fractional seconds and time-unit scaling within the work budget', () => {
    const ordinary = erlangA(10, 12, 300, 120, 20)
    const fractional = erlangA(10, 12, .3, .12, .02)
    expect(fractional.serviceLevel).toBeCloseTo(ordinary.serviceLevel, 12)
    expect(fractional.abandonProb).toBeCloseTo(ordinary.abandonProb, 12)
    expect(fractional.asa * 1000).toBeCloseTo(ordinary.asa, 12)
  })

  it('uses the eventual answered fraction only with a negligible late-service bound', () => {
    const short = erlangA(48, 50, 240, 90, 20)
    const long = erlangA(48, 50, 240, 90, 1e6)
    expect(short.pWait * Math.exp(-1e6 / 90)).toBeLessThanOrEqual(1e-12)
    expect(long.serviceLevel).toBe(1 - short.abandonProb)
    expect(long.asa).toBe(short.asa)
    expect(long.occupancy).toBe(short.occupancy)
  })

  it('P(abandon) ~= theta * E[wait] (offered-load relation, 20% relative)', () => {
    // ASA here is the mean wait of answered calls, slightly below the
    // all-arrivals mean wait that makes the identity exact, hence the
    // loose tolerance.
    for (const [A, N, aht, patience] of [
      [20, 21, 300, 120],
      [48, 55, 240, 60],
    ] as const) {
      const r = erlangA(A, N, aht, patience, 20)
      const theta = 1 / patience
      expect(theta * r.asa).toBeGreaterThan(0.8 * r.abandonProb)
      expect(theta * r.asa).toBeLessThan(1.2 * r.abandonProb)
    }
  })

  it('SL over an effectively infinite window equals the answered fraction', () => {
    const r = erlangA(48, 50, 240, 90, 1e6)
    expect(r.serviceLevel).toBeCloseTo(1 - r.abandonProb, 6)
  })

  it('occupancy reflects served load only', () => {
    const r = erlangA(48, 50, 240, 60, 20)
    expect(r.occupancy).toBeCloseTo((48 * (1 - r.abandonProb)) / 50, 10)
    expect(r.occupancy).toBeLessThan(48 / 50)
  })

  it('is stable when N < A (overload absorbed by abandonment)', () => {
    const r = erlangA(48, 40, 240, 60, 20)
    expect(r.abandonProb).toBeGreaterThan(0.1)
    expect(r.serviceLevel).toBeGreaterThan(0)
    expect(r.serviceLevel).toBeLessThan(1)
    expect(Number.isFinite(r.asa)).toBe(true)
  })

  it('zero load answers everything instantly', () => {
    expect(erlangA(0, 5, 300, 60, 20)).toEqual({
      pWait: 0,
      abandonProb: 0,
      serviceLevel: 1,
      asa: 0,
      occupancy: 0,
    })
  })
})

describe('requiredAgents', () => {
  const slTarget = { pct: 0.8, seconds: 20 }
  it('avoids expensive search points that cannot serve enough of a 1000-Erlang queue', () => {
    const r = requiredAgents('erlangA', 30000, 60, 1800, { pct: .8, seconds: 60 }, 300)
    expect(r.sl).toBeGreaterThanOrEqual(.8)
    expect(erlangA(1000, r.bodies - 1, 60, 300, 60).serviceLevel).toBeLessThan(.8)
    const capped = requiredAgents('erlangA', 30000, 60, 1800, { pct: .5, seconds: 60 }, 300, .01)
    expect(capped.abandonPct).toBeLessThanOrEqual(.01)
  })

  it('erlangC: returns N > A and meets the target', () => {
    const r = requiredAgents('erlangC', 360, 240, 1800, slTarget)
    expect(r.bodies).toBeGreaterThan(48) // A = 48
    expect(r.bodies).toBe(54) // first N with SL >= 80% in 20 s (SL(48,54) = 0.817)
    expect(r.sl).toBeGreaterThanOrEqual(0.8)
    // Minimality: one fewer agent misses the target.
    expect(serviceLevel(48, r.bodies - 1, 240, 20)).toBeLessThan(0.8)
  })

  it('occupancy cap raises N beyond the SL answer', () => {
    const uncapped = requiredAgents('erlangC', 360, 240, 1800, slTarget)
    const capped = requiredAgents('erlangC', 360, 240, 1800, slTarget, undefined, undefined, 0.75)
    expect(capped.bodies).toBeGreaterThan(uncapped.bodies)
    expect(capped.bodies).toBe(Math.ceil(48 / 0.75)) // 64
    expect(capped.occupancy).toBeLessThanOrEqual(0.75)
  })

  it('erlangA: meets SL and abandonment cap', () => {
    const r = requiredAgents('erlangA', 360, 240, 1800, slTarget, 90, 0.03)
    expect(r.bodies).toBeGreaterThan(48)
    expect(r.sl).toBeGreaterThanOrEqual(0.8)
    expect(r.abandonPct).toBeLessThanOrEqual(0.03)
  })

  it('erlangA: a tight abandonment cap raises N above the SL-only answer', () => {
    const slOnly = requiredAgents('erlangA', 360, 240, 1800, { pct: 0.5, seconds: 20 }, 90)
    const withCap = requiredAgents('erlangA', 360, 240, 1800, { pct: 0.5, seconds: 20 }, 90, 0.005)
    expect(withCap.bodies).toBeGreaterThan(slOnly.bodies)
    expect(withCap.abandonPct).toBeLessThanOrEqual(0.005)
  })

  it('low load: a single agent suffices when it meets the target', () => {
    // A = 6 * 60 / 1800 = 0.2 erlangs; SL(0.2, 1) = 0.847 for 80/20.
    const c = requiredAgents('erlangC', 6, 60, 1800, slTarget)
    expect(c.bodies).toBe(1)
    const a = requiredAgents('erlangA', 6, 60, 1800, slTarget, 90)
    expect(a.bodies).toBe(1)
  })

  it('zero volume needs zero agents', () => {
    expect(requiredAgents('erlangC', 0, 240, 1800, slTarget)).toEqual({
      bodies: 0,
      sl: 1,
      asa: 0,
      occupancy: 0,
      abandonPct: 0,
    })
  })

  it('erlangA mode requires patience', () => {
    expect(() => requiredAgents('erlangA', 100, 240, 1800, slTarget)).toThrow()
  })
})

describe('erlangA staffing below offered load', () => {
  it('finds the minimal N even below ceil(A) when abandonment makes it feasible', () => {
    // A = 3600 * 240 / 1800 = 480 erlangs, impatient callers (30 s patience):
    // SL 80% in 60 s is met well below the offered load.
    const target = { pct: 0.8, seconds: 60 }
    const r = requiredAgents('erlangA', 3600, 240, 1800, target, 30)
    expect(r.bodies).toBeLessThan(480)
    expect(r.sl).toBeGreaterThanOrEqual(0.8)
    // Minimality: one fewer agent misses the target.
    const below = erlangA(480, r.bodies - 1, 240, 30, 60)
    expect(below.serviceLevel).toBeLessThan(0.8)
  })

  it('erlangC still starts at the stability bound', () => {
    const r = requiredAgents('erlangC', 3600, 240, 1800, { pct: 0.8, seconds: 60 })
    expect(r.bodies).toBeGreaterThan(480)
  })
})

it('rejects oversized load promptly and solves the supported 1000-Erlang boundary unchanged', () => {
  for (const mode of ['erlangC', 'erlangA'] as const) {
    expect(() => requiredAgents(mode, 60000000000, 300, 1800, { pct: .8, seconds: 20 }, 120)).toThrow('1000 Erlangs')
    expect(() => requiredAgents(mode, 6000.01, 300, 1800, { pct: .8, seconds: 20 }, 120)).toThrow('1000 Erlangs')
    const r = requiredAgents(mode, 6000, 300, 1800, { pct: .95, seconds: 10 }, 120, .01, .75)
    expect(r.bodies).toBe(1334)
    expect(r.sl).toBeGreaterThanOrEqual(.95)
    expect(r.occupancy).toBeLessThanOrEqual(.75)
  }
  expect(() => requiredAgents('erlangC', 6000, 300, 1800, { pct: .8, seconds: 20 }, undefined, undefined, .1)).toThrow('more than 2000')
})
