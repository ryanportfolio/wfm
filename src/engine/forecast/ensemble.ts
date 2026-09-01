import type { RelErrorSample } from '../types'
import type { ForecastInput } from '../series'
import { relError } from '../metrics'
import { forecastSma } from './sma'
import { forecastHoltWinters } from './holtWinters'
import { forecastDhr } from './dhr'

/**
 * Blend of the three components with separate weights per horizon bucket
 * (1-3d, 4-14d, 15-28d), fitted by an internal rolling-origin evaluation on
 * the training window. Each inner fold trains the components on CLEANED
 * history up to its origin and scores them on the following evaluation
 * window against RAW actuals (the caller passes raw daily totals aligned
 * with the cleaned training series), mirroring the outer backtest: fit on
 * cleaned data, judge on what really happened. Inner folds step back by the
 * full evaluation window by default, so evaluation windows never overlap and
 * pooled errors are not double-counted. The evaluation window matches the
 * requested horizon (capped at the last bucket's end), so only the buckets
 * that horizon can reach are fitted.
 *
 * Weighting schemes (see solveWeights):
 * - 'power':      weight_m proportional to (1 / WAPE_m)^power per bucket,
 *                 with a fixed power.
 * - 'tunedPower': same formula, but the power is picked from a small grid
 *                 (1, 2, 4, 8, Infinity) by pooled inner blend WAPE across
 *                 all evaluation days; ties go to the smaller power, which
 *                 hedges harder. Infinity is the all-on-the-best-component
 *                 limit. The grid spans "hedge evenly" to "trust the
 *                 winner", so the data decides how concentrated the blend
 *                 should be instead of a hard-coded exponent.
 * - 'bestShrink': all weight on the bucket's best component, shrunk toward
 *                 equal weights by `shrink`.
 * The default is 'tunedPower'; the outer rolling-origin backtest on the
 * bundled sample data scores it at or below the fixed-power and best-shrink
 * variants on every queue (see backtest.test.ts for the enforced bound).
 *
 * Equal weights when history is shorter than `minHistoryDays` non-holiday
 * days (26 weeks) or fewer than two inner folds fit.
 */

export type ComponentName = 'sma' | 'hw' | 'dhr'
export const COMPONENT_NAMES: ComponentName[] = ['sma', 'hw', 'dhr']

export interface HorizonBucket {
  label: string
  /** 1-based first horizon day (inclusive) */
  fromDay: number
  /** 1-based last horizon day (inclusive) */
  toDay: number
}

export const HORIZON_BUCKETS: HorizonBucket[] = [
  { label: '1-3d', fromDay: 1, toDay: 3 },
  { label: '4-14d', fromDay: 4, toDay: 14 },
  { label: '15-28d', fromDay: 15, toDay: 28 },
]

export interface BucketWeights {
  label: string
  fromDay: number
  toDay: number
  /** Blend weight per component, summing to 1 */
  weights: Record<ComponentName, number>
  /** Internal rolling-origin WAPE per component (null on equal-weights fallback) */
  wapes: Record<ComponentName, number> | null
}

export interface EnsembleWeights {
  buckets: BucketWeights[]
  /** True when equal weights were used (short history or failed evaluation) */
  fallbackEqual: boolean
  /** Number of internal folds actually evaluated */
  innerFolds: number
  /**
   * Relative errors of the fitted blend on the inner evaluation days,
   * for prediction-interval calibration (see intervals.ts). Empty on the
   * equal-weights fallback. Slightly optimistic versus outer backtest
   * errors, since the blend weights were tuned on these same days.
   */
  innerErrors: RelErrorSample[]
}

export type WeightScheme = 'power' | 'tunedPower' | 'bestShrink'

export interface EnsembleOpts {
  innerFolds?: number
  /** Days between inner fold origins; defaults to the evaluation window so folds never overlap */
  innerStepDays?: number
  minHistoryDays?: number
  /** Exponent for scheme 'power' */
  power?: number
  scheme?: WeightScheme
  /** Weight kept on the equal blend for scheme 'bestShrink' */
  shrink?: number
}

const DEFAULTS = {
  innerFolds: 4,
  minHistoryDays: 182,
  power: 2,
  scheme: 'tunedPower' as WeightScheme,
  shrink: 0.25,
}
export const MIN_INNER_TRAIN_DAYS = 98
const EPS = 1e-6
/** Candidate exponents for scheme 'tunedPower', ascending; ties pick the earliest. */
const POWER_GRID = [1, 2, 4, 8, Infinity]

export function runComponents(input: ForecastInput): Record<ComponentName, number[]> {
  return {
    sma: forecastSma(input),
    hw: forecastHoltWinters(input),
    dhr: forecastDhr(input),
  }
}

function equalWeights(innerFolds: number): EnsembleWeights {
  return {
    buckets: HORIZON_BUCKETS.map((b) => ({
      label: b.label,
      fromDay: b.fromDay,
      toDay: b.toDay,
      weights: { sma: 1 / 3, hw: 1 / 3, dhr: 1 / 3 },
      wapes: null,
    })),
    fallbackEqual: true,
    innerFolds,
    innerErrors: [],
  }
}

/** 0-based bucket for a 1-based horizon day; days past the last bucket use it. */
export function bucketIndex(horizonDay: number): number {
  for (let i = 0; i < HORIZON_BUCKETS.length; i++) {
    if (horizonDay <= HORIZON_BUCKETS[i].toDay) return i
  }
  return HORIZON_BUCKETS.length - 1
}

/**
 * Inner fold origins (index of each fold's first evaluation day), latest
 * fold first. With stepDays >= evalDays the evaluation windows
 * [origin, origin + evalDays) are pairwise disjoint. Folds whose training
 * slice would fall under MIN_INNER_TRAIN_DAYS are dropped.
 */
export function innerFoldOrigins(
  trainLength: number,
  evalDays: number,
  folds: number,
  stepDays: number,
): number[] {
  const origins: number[] = []
  for (let f = 0; f < folds; f++) {
    const origin = trainLength - evalDays - f * stepDays
    if (origin >= MIN_INNER_TRAIN_DAYS) origins.push(origin)
  }
  return origins
}

/** One inner-fold evaluation day: raw actual vs each component's forecast. */
export interface InnerEvalDay {
  /** 0-based horizon bucket (bucketIndex of the day's 1-based horizon day) */
  bucket: number
  /** Raw (uncleaned) actual daily total */
  actual: number
  /** One forecast per component, COMPONENT_NAMES order */
  forecasts: number[]
}

export interface SolvedBucket {
  /** One weight per component, COMPONENT_NAMES order, summing to 1 */
  weights: number[]
  /** Pooled inner WAPE per component, or null when the bucket had no volume */
  wapes: number[] | null
}

function powerWeights(wapes: number[], power: number): number[] {
  if (!Number.isFinite(power)) {
    // Limit of power -> Infinity: all weight on the lowest-WAPE component.
    const best = wapes.indexOf(Math.min(...wapes))
    return wapes.map((_, m) => (m === best ? 1 : 0))
  }
  const raw = wapes.map((w) => Math.pow(1 / Math.max(w, EPS), power))
  const sum = raw.reduce((a, v) => a + v, 0)
  return raw.map((v) => v / sum)
}

/** Pooled WAPE of the blended forecast over all evaluation days. */
function blendWape(days: InnerEvalDay[], weightsByBucket: number[][]): number {
  let err = 0
  let act = 0
  for (const d of days) {
    const w = weightsByBucket[d.bucket]
    let v = 0
    for (let m = 0; m < d.forecasts.length; m++) v += w[m] * d.forecasts[m]
    err += Math.abs(Math.max(0, v) - d.actual)
    act += Math.abs(d.actual)
  }
  return act > 0 ? err / act : Number.POSITIVE_INFINITY
}

/**
 * Turn pooled inner-fold evaluation days into per-bucket blend weights.
 * Buckets with no evaluation volume fall back to equal weights.
 */
export function solveWeights(days: InnerEvalDay[], opts: EnsembleOpts = {}): SolvedBucket[] {
  const { power, scheme, shrink } = { ...DEFAULTS, ...opts }
  const nComp = COMPONENT_NAMES.length
  const nBuckets = HORIZON_BUCKETS.length

  const absErr = Array.from({ length: nBuckets }, () => new Array<number>(nComp).fill(0))
  const absAct = new Array<number>(nBuckets).fill(0)
  for (const d of days) {
    absAct[d.bucket] += Math.abs(d.actual)
    for (let m = 0; m < nComp; m++) absErr[d.bucket][m] += Math.abs(d.forecasts[m] - d.actual)
  }

  const equal = new Array<number>(nComp).fill(1 / nComp)
  const bucketWapes: (number[] | null)[] = absAct.map((act, b) =>
    act > 0 ? absErr[b].map((e) => e / act) : null,
  )

  const weightsFor = (p: number): number[][] =>
    bucketWapes.map((w) => (w ? powerWeights(w, p) : equal.slice()))

  let weightsByBucket: number[][]
  if (scheme === 'power') {
    weightsByBucket = weightsFor(power)
  } else if (scheme === 'bestShrink') {
    weightsByBucket = bucketWapes.map((w) => {
      if (!w) return equal.slice()
      const best = w.indexOf(Math.min(...w))
      return w.map((_, m) => (m === best ? 1 - shrink + shrink / nComp : shrink / nComp))
    })
  } else {
    // tunedPower: pick the grid exponent whose blend scores the lowest pooled
    // inner WAPE; ascending grid + strict < means ties keep the smaller
    // (more hedged) power.
    let bestScore = Number.POSITIVE_INFINITY
    weightsByBucket = weightsFor(POWER_GRID[0])
    for (const p of POWER_GRID) {
      const candidate = weightsFor(p)
      const score = blendWape(days, candidate)
      if (score < bestScore) {
        bestScore = score
        weightsByBucket = candidate
      }
    }
  }

  return weightsByBucket.map((w, b) => ({ weights: w, wapes: bucketWapes[b] }))
}

/**
 * Fit per-bucket blend weights from a rolling-origin evaluation inside the
 * training window. `input.train` is the cleaned series the components fit
 * on; `rawTrainTotals`, when given, must hold the raw (uncleaned) daily
 * totals for the same dates in the same order, and inner evaluation scores
 * against them. Without it the cleaned totals are used (tests and callers
 * that have no raw series), which biases weights toward smooth components.
 */
export function fitEnsembleWeights(
  input: ForecastInput,
  opts: EnsembleOpts = {},
  rawTrainTotals?: number[],
): EnsembleWeights {
  const { innerFolds, minHistoryDays } = { ...DEFAULTS, ...opts }
  const train = input.train
  // Evaluate exactly the horizon being forecast, capped at the bucket range;
  // buckets a shorter horizon never reaches stay at equal weights (unused).
  const maxBucketDay = HORIZON_BUCKETS[HORIZON_BUCKETS.length - 1].toDay
  const evalDays = Math.max(1, Math.min(input.futureDates.length || maxBucketDay, maxBucketDay))
  const stepDays = opts.innerStepDays ?? evalDays

  const nonHolidayDays = train.reduce((acc, p) => acc + (input.trainHolidays.has(p.date) ? 0 : 1), 0)
  if (nonHolidayDays < minHistoryDays) return equalWeights(0)

  const origins = innerFoldOrigins(train.length, evalDays, innerFolds, stepDays)
  if (origins.length < 2) return equalWeights(origins.length)

  const innerDays: InnerEvalDay[] = []
  /** 1-based lead day of innerDays[i] within its fold's evaluation window. */
  const innerLeads: number[] = []
  for (const origin of origins) {
    const innerTrain = train.slice(0, origin)
    const evalPoints = train.slice(origin, origin + evalDays)
    const innerInput: ForecastInput = {
      train: innerTrain,
      trainHolidays: input.trainHolidays,
      futureDates: evalPoints.map((p) => p.date),
      futureHolidays: input.trainHolidays,
      calendarHolidays: input.calendarHolidays,
    }
    const components = runComponents(innerInput)
    for (let j = 0; j < evalPoints.length; j++) {
      innerDays.push({
        bucket: bucketIndex(j + 1),
        actual: rawTrainTotals ? rawTrainTotals[origin + j] : evalPoints[j].total,
        forecasts: COMPONENT_NAMES.map((name) => components[name][j]),
      })
      innerLeads.push(j + 1)
    }
  }

  const solved = solveWeights(innerDays, opts)

  // Relative errors of the solved blend on the same evaluation days, kept for
  // prediction-interval calibration. Zero-forecast days (closed holidays)
  // yield no error sample.
  const innerErrors: RelErrorSample[] = []
  innerDays.forEach((d, i) => {
    const w = solved[d.bucket].weights
    let v = 0
    for (let m = 0; m < d.forecasts.length; m++) v += w[m] * d.forecasts[m]
    const rel = relError(d.actual, Math.max(0, v))
    if (rel !== null) innerErrors.push({ lead: innerLeads[i], rel })
  })

  const buckets: BucketWeights[] = HORIZON_BUCKETS.map((bucket, b) => {
    const weights = { sma: 0, hw: 0, dhr: 0 }
    const wapeRec = solved[b].wapes ? { sma: 0, hw: 0, dhr: 0 } : null
    COMPONENT_NAMES.forEach((name, m) => {
      weights[name] = solved[b].weights[m]
      if (wapeRec) wapeRec[name] = solved[b].wapes![m]
    })
    return { label: bucket.label, fromDay: bucket.fromDay, toDay: bucket.toDay, weights, wapes: wapeRec }
  })

  return { buckets, fallbackEqual: false, innerFolds: origins.length, innerErrors }
}

/** Blend component daily forecasts using per-horizon-bucket weights. */
export function blendComponents(
  components: Record<ComponentName, number[]>,
  weights: EnsembleWeights,
): number[] {
  const n = components.sma.length
  const out = new Array<number>(n)
  for (let j = 0; j < n; j++) {
    const bucket = weights.buckets[bucketIndex(j + 1)]
    let v = 0
    for (const name of COMPONENT_NAMES) v += bucket.weights[name] * components[name][j]
    out[j] = Math.max(0, v)
  }
  return out
}

export interface EnsembleForecast {
  components: Record<ComponentName, number[]>
  blend: number[]
  weights: EnsembleWeights
}

/**
 * Fit weights on the training window, run components, blend. Pass
 * `rawTrainTotals` (raw daily totals aligned with `input.train`) so the
 * inner evaluation scores against raw actuals like the outer backtest.
 */
export function forecastEnsemble(
  input: ForecastInput,
  opts: EnsembleOpts = {},
  rawTrainTotals?: number[],
): EnsembleForecast {
  const weights = fitEnsembleWeights(input, opts, rawTrainTotals)
  const components = runComponents(input)
  return { components, blend: blendComponents(components, weights), weights }
}
