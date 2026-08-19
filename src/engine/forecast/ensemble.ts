import type { ForecastInput } from '../series'
import { forecastSma } from './sma'
import { forecastHoltWinters } from './holtWinters'
import { forecastDhr } from './dhr'

/**
 * Inverse-WAPE weighted blend of the three components with separate weights
 * per horizon bucket (1-3d, 4-14d, 15-28d). Weights come from an internal
 * rolling-origin evaluation on the training window (default 4 folds, 14-day
 * step): per bucket, weight_m proportional to (1 / WAPE_m)^POWER,
 * renormalized. POWER = 2 concentrates weight on the strongest component
 * while still hedging across them. Equal weights when history is shorter
 * than 26 weeks or the internal evaluation cannot run.
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
}

export interface EnsembleOpts {
  innerFolds?: number
  innerStepDays?: number
  minHistoryDays?: number
  power?: number
}

const DEFAULTS = { innerFolds: 4, innerStepDays: 14, minHistoryDays: 182, power: 2 }
const MIN_INNER_TRAIN_DAYS = 98
const EPS = 1e-6

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
  }
}

function bucketIndex(horizonDay: number): number {
  for (let i = 0; i < HORIZON_BUCKETS.length; i++) {
    if (horizonDay <= HORIZON_BUCKETS[i].toDay) return i
  }
  return HORIZON_BUCKETS.length - 1
}

/**
 * Fit per-bucket blend weights from a rolling-origin evaluation inside the
 * training window.
 */
export function fitEnsembleWeights(input: ForecastInput, opts: EnsembleOpts = {}): EnsembleWeights {
  const { innerFolds, innerStepDays, minHistoryDays, power } = { ...DEFAULTS, ...opts }
  const train = input.train
  const horizon = 28
  const nonHolidayDays = train.reduce((acc, p) => acc + (input.trainHolidays.has(p.date) ? 0 : 1), 0)
  if (nonHolidayDays < minHistoryDays) return equalWeights(0)

  // Inner fold origins: index of the first evaluation day, latest fold last.
  const origins: number[] = []
  for (let f = 0; f < innerFolds; f++) {
    const origin = train.length - horizon - f * innerStepDays
    if (origin >= MIN_INNER_TRAIN_DAYS) origins.push(origin)
  }
  if (origins.length < 2) return equalWeights(origins.length)

  // Pooled |error| and |actual| per (component, bucket).
  const absErr = COMPONENT_NAMES.map(() => HORIZON_BUCKETS.map(() => 0))
  const absAct = HORIZON_BUCKETS.map(() => 0)

  for (const origin of origins) {
    const innerTrain = train.slice(0, origin)
    const evalPoints = train.slice(origin, origin + horizon)
    const innerInput: ForecastInput = {
      train: innerTrain,
      trainHolidays: input.trainHolidays,
      futureDates: evalPoints.map((p) => p.date),
      futureHolidays: input.trainHolidays,
    }
    const components = runComponents(innerInput)
    for (let j = 0; j < evalPoints.length; j++) {
      const b = bucketIndex(j + 1)
      const actual = evalPoints[j].total
      absAct[b] += Math.abs(actual)
      for (let m = 0; m < COMPONENT_NAMES.length; m++) {
        absErr[m][b] += Math.abs(components[COMPONENT_NAMES[m]][j] - actual)
      }
    }
  }

  const buckets: BucketWeights[] = HORIZON_BUCKETS.map((bucket, b) => {
    if (absAct[b] <= 0) {
      return {
        label: bucket.label,
        fromDay: bucket.fromDay,
        toDay: bucket.toDay,
        weights: { sma: 1 / 3, hw: 1 / 3, dhr: 1 / 3 },
        wapes: null,
      }
    }
    const wapes = COMPONENT_NAMES.map((_, m) => absErr[m][b] / absAct[b])
    const raw = wapes.map((w) => Math.pow(1 / Math.max(w, EPS), power))
    const sum = raw.reduce((a, v) => a + v, 0)
    const weights = { sma: 0, hw: 0, dhr: 0 }
    const wapeRec = { sma: 0, hw: 0, dhr: 0 }
    COMPONENT_NAMES.forEach((name, m) => {
      weights[name] = raw[m] / sum
      wapeRec[name] = wapes[m]
    })
    return { label: bucket.label, fromDay: bucket.fromDay, toDay: bucket.toDay, weights, wapes: wapeRec }
  })

  return { buckets, fallbackEqual: false, innerFolds: origins.length }
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

/** Fit weights on the training window, run components, blend. */
export function forecastEnsemble(input: ForecastInput, opts: EnsembleOpts = {}): EnsembleForecast {
  const weights = fitEnsembleWeights(input, opts)
  const components = runComponents(input)
  return { components, blend: blendComponents(components, weights), weights }
}
