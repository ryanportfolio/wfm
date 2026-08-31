/**
 * Erlang B / C / A queueing math for interval staffing.
 *
 * Conventions:
 * - A = offered load in erlangs = volume * ahtSec / intervalSec.
 * - All probabilities and "pct" values are fractions in [0, 1] (0.8 = 80%).
 * - Rates are per second: mu = 1/ahtSec, theta = 1/patienceSec.
 */

/**
 * Erlang B blocking probability via the numerically stable recursion:
 * B(0) = 1; B(k) = A*B(k-1) / (k + A*B(k-1)).
 */
export function erlangB(A: number, N: number): number {
  if (A <= 0) return 0
  let b = 1
  for (let k = 1; k <= N; k++) {
    b = (A * b) / (k + A * b)
  }
  return b
}

/**
 * Erlang C probability that an arriving call waits (M/M/N).
 * C = N*B / (N - A*(1-B)). Only meaningful for N > A; for N <= A the
 * queue is unstable and every call waits, so we return 1.
 */
export function erlangC(A: number, N: number): number {
  if (A <= 0) return 0
  if (N <= A) return 1
  const b = erlangB(A, N)
  const c = (N * b) / (N - A * (1 - b))
  return Math.min(1, Math.max(0, c))
}

/**
 * Erlang C service level: fraction of calls answered within targetSec.
 * SL = 1 - C * exp(-(N - A) * targetSec / ahtSec). Returns 0 when N <= A.
 */
export function serviceLevel(A: number, N: number, ahtSec: number, targetSec: number): number {
  if (A <= 0) return 1
  if (N <= A) return 0
  const c = erlangC(A, N)
  const sl = 1 - c * Math.exp((-(N - A) * targetSec) / ahtSec)
  return Math.min(1, Math.max(0, sl))
}

/**
 * Erlang C average speed of answer, seconds. Infinity when N <= A.
 */
export function asa(A: number, N: number, ahtSec: number): number {
  if (A <= 0) return 0
  if (N <= A) return Infinity
  return (erlangC(A, N) * ahtSec) / (N - A)
}

/** Occupancy A/N (Erlang C; no abandonment). */
export function occupancy(A: number, N: number): number {
  if (N <= 0) return A > 0 ? Infinity : 0
  return A / N
}

export interface ErlangAResult {
  /** Probability an arriving call waits (all N servers busy at arrival). */
  pWait: number
  /** Probability an arriving call abandons before service. */
  abandonProb: number
  /** Fraction of ALL arrivals answered within targetSec. */
  serviceLevel: number
  /** Mean wait of answered calls, seconds (calls answered at once count 0). */
  asa: number
  /** Occupancy on served load: A * (1 - abandonProb) / N. */
  occupancy: number
}

/**
 * Erlang A: M/M/N+M with exponential patience (mean patienceSec).
 *
 * Stationary distribution of the birth-death chain on the number in system j:
 * births at rate lambda; deaths at rate j*mu for j <= N and N*mu + k*theta for
 * j = N + k (k callers waiting; each waiting caller abandons at rate theta).
 * Weights are accumulated in log space and exp-normalized, so no overflow;
 * queue states are truncated once the geometric tail bound drops below 1e-13
 * of the largest weight (the death rate grows linearly in k, so the tail
 * always dies).
 *
 * Waiting-time math (used for abandonProb, ASA, and SL within t):
 * By PASTA an arrival sees the stationary state. An arrival that finds
 * j = N + k in system has k callers ahead of it in queue. Track m = number
 * still ahead. While the tagged caller waits, three exponential races run:
 *  - a "down" event at rate d_m = N*mu + m*theta (a service completion frees
 *    a server for the head of queue, or someone ahead abandons): m -> m-1;
 *    from m = 0 the down event (rate N*mu) puts the tagged caller in service;
 *  - the tagged caller's own abandonment at rate theta (absorbing).
 * Total exit rate in phase m is R_m = d_m + theta. Because the abandonment
 * hazard simply adds to the exit rate, the chain factorizes exactly:
 *  - P(served | k ahead)          = prod_{m=0..k} d_m / R_m
 *  - W | served, k ahead          ~ Hypoexponential(R_0, ..., R_k)
 *    so E[W | served, k]          = sum_{m=0..k} 1 / R_m
 *  - P(served and W <= t | k)     = P(served | k) * P(Hypo(R_0..R_k) <= t)
 * SL(t) = P(arrival sees j < N) + sum_k p(N+k) * P(served and W <= t | k).
 * The hypoexponential CDF, aggregated over the arrival distribution, is
 * evaluated by uniformization of the phase chain (rate LAMBDA = max R_m,
 * Poisson-weighted DTMC steps): all terms are positive, so it is stable for
 * any queue length, unlike the alternating-sign closed form.
 */
export function erlangA(
  A: number,
  N: number,
  ahtSec: number,
  patienceSec: number,
  targetSec: number,
): ErlangAResult {
  if (A <= 0) return { pWait: 0, abandonProb: 0, serviceLevel: 1, asa: 0, occupancy: 0 }
  if (!(N >= 1)) throw new Error('erlangA requires N >= 1')
  if (!(ahtSec > 0) || !(patienceSec > 0)) throw new Error('erlangA requires ahtSec > 0 and patienceSec > 0')

  const mu = 1 / ahtSec
  const theta = 1 / patienceSec

  // Unnormalized stationary log-weights.
  const logW: number[] = [0]
  let log = 0
  let maxLog = 0
  for (let j = 1; j <= N; j++) {
    log += Math.log(A / j)
    logW.push(log)
    if (log > maxLog) maxLog = log
  }
  // Queue states j = N + k. Ratio lambda / (N*mu + k*theta) = A / (N + k*ahtSec/patienceSec).
  const thetaOverMu = ahtSec / patienceSec
  const MAX_QUEUE = 1_000_000
  for (let k = 1; k <= MAX_QUEUE; k++) {
    const ratio = A / (N + k * thetaOverMu)
    log += Math.log(ratio)
    logW.push(log)
    if (log > maxLog) maxLog = log
    if (ratio < 1) {
      // Remaining tail < term * ratio / (1 - ratio) (ratios are decreasing).
      const tailBound = Math.exp(log - maxLog) * (ratio / (1 - ratio))
      if (tailBound < 1e-13) break
    }
    if (k === MAX_QUEUE) throw new Error('erlangA queue truncation did not converge')
  }

  let sum = 0
  const p = logW.map((lw) => {
    const w = Math.exp(lw - maxLog)
    sum += w
    return w
  })
  for (let j = 0; j < p.length; j++) p[j] /= sum

  const K = p.length - N // waiting phases m = 0..K-1 (state N+m seen at arrival)

  let pWait = 0
  let abandonProb = 0
  let servedWaitSum = 0 // E[W * 1{served}] over all arrivals
  let pServed = 1
  let sumInvR = 0
  for (let m = 0; m < K; m++) {
    const d = N * mu + m * theta
    const R = d + theta
    pServed *= d / R
    sumInvR += 1 / R
    const pk = p[N + m]
    pWait += pk
    abandonProb += pk * (1 - pServed)
    servedWaitSum += pk * pServed * sumInvR
  }

  const answered = 1 - abandonProb
  const asaOut = answered > 0 ? servedWaitSum / answered : Infinity

  // SL within targetSec by uniformization over the tagged-caller phase chain.
  let slWait = 0
  if (targetSec > 0 && pWait > 0) {
    const LAMBDA = N * mu + K * theta // = max R_m over m = 0..K-1
    const a = LAMBDA * targetSec
    const v = new Float64Array(K)
    let servedWaitingBound = 0
    {
      let ps = 1
      for (let m = 0; m < K; m++) {
        v[m] = p[N + m]
        ps *= (N * mu + m * theta) / (N * mu + (m + 1) * theta)
        servedWaitingBound += p[N + m] * ps
      }
    }
    let absorbed = 0
    let logQ = -a // log Poisson pmf, n = 0
    let cum = Math.exp(logQ)
    slWait += cum * absorbed // zero, kept for clarity
    const logA_ = Math.log(a)
    const nMax = Math.ceil(a + 12 * Math.sqrt(a) + 200)
    for (let n = 1; n <= nMax; n++) {
      // One uniformized DTMC step.
      absorbed += (v[0] * (N * mu)) / LAMBDA
      for (let m = 0; m < K; m++) {
        const R = N * mu + (m + 1) * theta
        const inflow = m + 1 < K ? (v[m + 1] * (N * mu + (m + 1) * theta)) / LAMBDA : 0
        v[m] = v[m] * (1 - R / LAMBDA) + inflow
      }
      logQ += logA_ - Math.log(n)
      const q = Math.exp(logQ)
      slWait += q * absorbed
      cum += q
      if (n > a && (1 - cum) * servedWaitingBound < 1e-12) break
    }
    // Residual Poisson mass beyond nMax: absorbed is nondecreasing, so cap it.
    slWait += (1 - cum) * absorbed
  }

  const sl = Math.min(1, Math.max(0, 1 - pWait + slWait))
  const occ = (A * answered) / N

  return { pWait, abandonProb, serviceLevel: sl, asa: asaOut, occupancy: occ }
}

export interface SlTarget {
  /** Target fraction answered in time, e.g. 0.8 for 80%. */
  pct: number
  /** Answer-time threshold, seconds, e.g. 20. */
  seconds: number
}

export interface RequiredAgentsResult {
  /** Agents on the phones (before shrinkage gross-up). */
  bodies: number
  sl: number
  asa: number
  occupancy: number
  /** Abandonment fraction (0 in erlangC mode). */
  abandonPct: number
}

export type ErlangMode = 'erlangC' | 'erlangA'

/**
 * Smallest integer agent count N that meets the SL target, the optional
 * abandonment cap (erlangA only), and the optional occupancy cap (occupancy
 * falls as N rises, so the cap can only raise N).
 *
 * Erlang C needs N > A for a stable queue, so the search starts at
 * max(1, ceil(A)). Erlang A is stable at any N >= 1 because abandonment sheds
 * load, and with impatient callers the targets can be met below the offered
 * load; feasibility is monotone in N (SL rises, abandonment and occupancy
 * fall), so after finding a feasible N by scanning up, a binary search finds
 * the true minimum down to 1.
 */
const requiredAgentsCache = new Map<string, RequiredAgentsResult>()
const REQUIRED_AGENTS_CACHE_MAX = 50_000

export function requiredAgents(
  mode: ErlangMode,
  volume: number,
  ahtSec: number,
  intervalSec: number,
  slTarget: SlTarget,
  patienceSec?: number,
  maxAbandonPct?: number,
  occupancyCap?: number,
): RequiredAgentsResult {
  if (volume <= 0 || ahtSec <= 0) {
    return { bodies: 0, sl: 1, asa: 0, occupancy: 0, abandonPct: 0 }
  }
  // Exact-argument memo: capacity planning and live what-if sliders repeat
  // identical (volume, AHT, config) calls; results are deterministic.
  const cacheKey = `${mode}|${volume}|${ahtSec}|${intervalSec}|${slTarget.pct}|${slTarget.seconds}|${patienceSec}|${maxAbandonPct}|${occupancyCap}`
  const hit = requiredAgentsCache.get(cacheKey)
  if (hit !== undefined) return hit
  if (!(intervalSec > 0)) throw new Error('intervalSec must be > 0')
  if (!(slTarget.pct < 1)) throw new Error('slTarget.pct must be < 1 (Erlang SL never reaches 100%)')
  if (mode === 'erlangA' && !(patienceSec !== undefined && patienceSec > 0)) {
    throw new Error('erlangA mode requires patienceSec > 0')
  }

  const A = (volume * ahtSec) / intervalSec

  const evaluate = (N: number): RequiredAgentsResult & { feasible: boolean } => {
    let sl: number
    let asaVal: number
    let occ: number
    let abandon: number
    if (mode === 'erlangA') {
      const r = erlangA(A, N, ahtSec, patienceSec as number, slTarget.seconds)
      sl = r.serviceLevel
      asaVal = r.asa
      occ = r.occupancy
      abandon = r.abandonProb
    } else {
      sl = serviceLevel(A, N, ahtSec, slTarget.seconds)
      asaVal = asa(A, N, ahtSec)
      occ = occupancy(A, N)
      abandon = 0
    }
    const feasible =
      sl >= slTarget.pct &&
      (maxAbandonPct === undefined || abandon <= maxAbandonPct) &&
      (occupancyCap === undefined || occ <= occupancyCap)
    return { bodies: N, sl, asa: asaVal, occupancy: occ, abandonPct: abandon, feasible }
  }

  const start = Math.max(1, Math.ceil(A))
  const MAX_STEPS = 100_000
  for (let N = start; N < start + MAX_STEPS; N++) {
    const r = evaluate(N)
    if (!r.feasible) continue
    let best = r
    if (mode === 'erlangA' && N > 1) {
      // Feasibility is monotone in N; search below for the true minimum.
      let lo = 1
      let hi = N
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        const m = evaluate(mid)
        if (m.feasible) {
          best = m
          hi = mid
        } else {
          lo = mid + 1
        }
      }
    }
    const { feasible: _feasible, ...result } = best
    if (requiredAgentsCache.size >= REQUIRED_AGENTS_CACHE_MAX) requiredAgentsCache.clear()
    // Frozen because the same object is handed to every future caller.
    Object.freeze(result)
    requiredAgentsCache.set(cacheKey, result)
    return result
  }
  throw new Error('requiredAgents did not converge within 100000 agents above ceil(A)')
}
