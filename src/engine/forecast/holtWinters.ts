import type { ForecastInput } from '../series'

/**
 * Additive Holt-Winters with weekly seasonality (m = 7), error-correction
 * form (Hyndman & Athanasopoulos):
 *
 *   e_t     = y_t - (l + b + s[t mod 7])
 *   l_t     = l + b + alpha * e_t
 *   b_t     = b + alpha * beta * e_t
 *   s_t     = s[t mod 7] + gamma * (1 - alpha) * e_t
 *
 * Holiday handling: closed-holiday days are set aside (passed as null).
 * On a null day the recursion advances by the trend only (level += trend,
 * season untouched) and the day contributes nothing to the MSE, so the
 * business-day structure and the weekly index alignment are both preserved.
 * This choice keeps t mod 7 pinned to the calendar weekday, which a
 * skip-the-day business-day series would break.
 *
 * alpha/beta/gamma come from a coarse grid search minimizing one-step-ahead
 * MSE on the training window (first 4 weeks treated as warmup).
 */

const M = 7
const WARMUP = 28

export const HW_ALPHA_GRID = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]
export const HW_BETA_GRID = [0.05, 0.25, 0.45, 0.65, 0.85]
export const HW_GAMMA_GRID = [0.05, 0.25, 0.45, 0.65, 0.85]

export interface HoltWintersFit {
  alpha: number
  beta: number
  gamma: number
  /** One-step-ahead MSE on non-null days after warmup */
  mse: number
  /** Final level after the training window */
  level: number
  /** Final trend after the training window */
  trend: number
  /** Final seasonal terms indexed by t mod 7 (t = training array index) */
  season: number[]
  /** One-step-ahead fitted values (null where input was null) */
  fitted: (number | null)[]
}

interface InitState {
  level: number
  trend: number
  season: number[]
}

function initialState(values: (number | null)[]): InitState {
  const n = values.length
  const span = Math.min(n, WARMUP)
  const posSum = new Array(M).fill(0)
  const posCount = new Array(M).fill(0)
  let firstSum = 0
  let firstCount = 0
  let secondSum = 0
  let secondCount = 0
  for (let t = 0; t < span; t++) {
    const v = values[t]
    if (v === null) continue
    posSum[t % M] += v
    posCount[t % M]++
    if (t < span / 2) {
      firstSum += v
      firstCount++
    } else {
      secondSum += v
      secondCount++
    }
  }
  let overallSum = 0
  let overallCount = 0
  for (let s = 0; s < M; s++) {
    if (posCount[s] > 0) {
      overallSum += posSum[s] / posCount[s]
      overallCount++
    }
  }
  const level = overallCount > 0 ? overallSum / overallCount : 0
  const trend =
    firstCount > 0 && secondCount > 0 ? (secondSum / secondCount - firstSum / firstCount) / (span / 2) : 0
  const season = new Array(M).fill(0)
  for (let s = 0; s < M; s++) {
    if (posCount[s] > 0) season[s] = posSum[s] / posCount[s] - level
  }
  return { level, trend, season }
}

function runRecursion(
  values: (number | null)[],
  init: InitState,
  alpha: number,
  beta: number,
  gamma: number,
  collectFitted: boolean,
): HoltWintersFit {
  let level = init.level
  let trend = init.trend
  const season = init.season.slice()
  const fitted: (number | null)[] = collectFitted ? new Array(values.length).fill(null) : []
  let sse = 0
  let count = 0
  for (let t = 0; t < values.length; t++) {
    const s = t % M
    const yhat = level + trend + season[s]
    const y = values[t]
    if (y === null) {
      level += trend
      continue
    }
    if (collectFitted) fitted[t] = yhat
    const e = y - yhat
    if (t >= WARMUP) {
      sse += e * e
      count++
    }
    level = level + trend + alpha * e
    trend = trend + alpha * beta * e
    season[s] = season[s] + gamma * (1 - alpha) * e
  }
  return {
    alpha,
    beta,
    gamma,
    mse: count > 0 ? sse / count : Number.POSITIVE_INFINITY,
    level,
    trend,
    season,
    fitted,
  }
}

/**
 * Grid-search fit. `values` are daily totals in calendar order with null on
 * set-aside (closed-holiday) days.
 */
export function fitHoltWinters(values: (number | null)[]): HoltWintersFit {
  const init = initialState(values)
  let best: { alpha: number; beta: number; gamma: number; mse: number } | null = null
  for (const alpha of HW_ALPHA_GRID) {
    for (const beta of HW_BETA_GRID) {
      for (const gamma of HW_GAMMA_GRID) {
        const fit = runRecursion(values, init, alpha, beta, gamma, false)
        if (best === null || fit.mse < best.mse) {
          best = { alpha, beta, gamma, mse: fit.mse }
        }
      }
    }
  }
  return runRecursion(values, init, best!.alpha, best!.beta, best!.gamma, true)
}

export function forecastHoltWinters(input: ForecastInput): number[] {
  const values = input.train.map((p) => (input.trainHolidays.has(p.date) ? null : p.total))
  const fit = fitHoltWinters(values)
  const n = values.length
  return input.futureDates.map((date, j) => {
    if (input.futureHolidays.has(date)) return 0
    const raw = fit.level + (j + 1) * fit.trend + fit.season[(n + j) % M]
    return Math.max(0, raw)
  })
}
