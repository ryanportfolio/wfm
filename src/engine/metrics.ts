/**
 * Forecast accuracy metrics at arbitrary grain. All take aligned actual and
 * forecast vectors of equal length.
 */

function checkLengths(actual: number[], forecast: number[]): void {
  if (actual.length !== forecast.length) {
    throw new Error(`metrics: length mismatch (actual ${actual.length}, forecast ${forecast.length})`)
  }
}

/** Weighted absolute percentage error: sum|F - A| / sum|A|. NaN when sum|A| = 0. */
export function wape(actual: number[], forecast: number[]): number {
  checkLengths(actual, forecast)
  let errSum = 0
  let actSum = 0
  for (let i = 0; i < actual.length; i++) {
    errSum += Math.abs(forecast[i] - actual[i])
    actSum += Math.abs(actual[i])
  }
  return actSum > 0 ? errSum / actSum : Number.NaN
}

export interface MapeResult {
  /** Mean absolute percentage error over scored points */
  mape: number
  /** Fraction of points scored (actual = 0 points are skipped) */
  coverage: number
}

/**
 * MAPE with a small-denominator guard: points with actual = 0 are skipped
 * and the scored fraction reported as coverage.
 */
export function mape(actual: number[], forecast: number[]): MapeResult {
  checkLengths(actual, forecast)
  let sum = 0
  let scored = 0
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) continue
    sum += Math.abs((forecast[i] - actual[i]) / actual[i])
    scored++
  }
  return {
    mape: scored > 0 ? sum / scored : Number.NaN,
    coverage: actual.length > 0 ? scored / actual.length : 0,
  }
}

/** Signed bias: mean error / mean actual = (sumF - sumA) / sumA. NaN when sumA = 0. */
export function bias(actual: number[], forecast: number[]): number {
  checkLengths(actual, forecast)
  let actSum = 0
  let fcSum = 0
  for (let i = 0; i < actual.length; i++) {
    actSum += actual[i]
    fcSum += forecast[i]
  }
  return actSum !== 0 ? (fcSum - actSum) / actSum : Number.NaN
}
