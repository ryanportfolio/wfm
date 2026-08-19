import type { ForecastInput } from '../series'
import { dayNumFromIso, weekdayOfDayNum, civilFromDays } from '../series'

/**
 * Dynamic harmonic regression: ridge regression (closed-form normal
 * equations, Gaussian elimination with partial pivoting) on
 *
 *   - Fourier pairs: weekly K = 3 (phase on day number mod 7),
 *     yearly K = 2 (phase on day number / 365.25)
 *   - linear trend (days since training start, scaled by 365.25)
 *   - weekday dummies Mon..Sat (Sunday is the baseline)
 *   - holiday dummy, day-after-holiday dummy (first business day after a
 *     holiday), first-3-business-days-of-month dummy
 *
 * Features are standardized over the training rows (zero-variance columns
 * stay zero); lambda = 1 on standardized features, intercept unpenalized.
 * Closed-holiday training days are excluded from the fit (the holiday dummy
 * then covers holidays a queue keeps open). Predictions are floored at 0 and
 * future closed holidays forecast as zero.
 */

export const DHR_LAMBDA = 1.0
const WEEKLY_K = 3
const YEARLY_K = 2

// Fourier terms depend only on the absolute day number; memoized globally.
const fourierCache = new Map<number, number[]>()

function fourierFeatures(z: number): number[] {
  let cached = fourierCache.get(z)
  if (cached) return cached
  const out: number[] = []
  for (let k = 1; k <= WEEKLY_K; k++) {
    const phase = (2 * Math.PI * k * z) / 7
    out.push(Math.sin(phase), Math.cos(phase))
  }
  for (let k = 1; k <= YEARLY_K; k++) {
    const phase = (2 * Math.PI * k * z) / 365.25
    out.push(Math.sin(phase), Math.cos(phase))
  }
  fourierCache.set(z, cached = out)
  return cached
}

export interface DhrCalendar {
  /** All holiday day numbers relevant to the range (open or closed) */
  holidays: Set<number>
}

function isBusinessDay(z: number, holidays: Set<number>): boolean {
  const w = weekdayOfDayNum(z)
  return w >= 1 && w <= 5 && !holidays.has(z)
}

/** True when z is the first business day following a holiday. */
function isDayAfterHoliday(z: number, holidays: Set<number>): boolean {
  if (!isBusinessDay(z, holidays)) return false
  let p = z - 1
  while (p >= z - 7) {
    if (holidays.has(p)) return true
    if (isBusinessDay(p, holidays)) return false
    p--
  }
  return false
}

/**
 * Business-day-of-month ordinals for a contiguous day range, so the
 * first-3-business-days dummy is O(n) for the whole range.
 */
function businessOrdinals(startZ: number, endZ: number, holidays: Set<number>): Map<number, number> {
  const out = new Map<number, number>()
  // Walk back to the 1st of startZ's month so ordinals are correct at range start.
  const civil = civilFromDays(startZ)
  const monthStart = startZ - (civil.d - 1)
  let currentMonth = -1
  let ordinal = 0
  for (let z = monthStart; z <= endZ; z++) {
    const m = civilFromDays(z).m
    if (m !== currentMonth) {
      currentMonth = m
      ordinal = 0
    }
    if (isBusinessDay(z, holidays)) {
      ordinal++
      if (z >= startZ) out.set(z, ordinal)
    }
  }
  return out
}

function featureRow(
  z: number,
  trainStartZ: number,
  holidays: Set<number>,
  ordinals: Map<number, number>,
): number[] {
  const row: number[] = [(z - trainStartZ) / 365.25, ...fourierFeatures(z)]
  const w = weekdayOfDayNum(z)
  for (let d = 1; d <= 6; d++) row.push(w === d ? 1 : 0)
  row.push(holidays.has(z) ? 1 : 0)
  row.push(isDayAfterHoliday(z, holidays) ? 1 : 0)
  const ord = ordinals.get(z)
  row.push(ord !== undefined && ord <= 3 ? 1 : 0)
  return row
}

/** Solve Ax = b with Gaussian elimination and partial pivoting. A is mutated. */
export function solveLinearSystem(a: number[][], b: number[]): number[] {
  const n = b.length
  const x = b.slice()
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    }
    if (pivot !== col) {
      ;[a[col], a[pivot]] = [a[pivot], a[col]]
      ;[x[col], x[pivot]] = [x[pivot], x[col]]
    }
    const diag = a[col][col]
    if (Math.abs(diag) < 1e-12) continue // singular direction; ridge makes this rare
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / diag
      if (factor === 0) continue
      for (let c = col; c < n; c++) a[r][c] -= factor * a[col][c]
      x[r] -= factor * x[col]
    }
  }
  for (let col = n - 1; col >= 0; col--) {
    let sum = x[col]
    for (let c = col + 1; c < n; c++) sum -= a[col][c] * x[c]
    x[col] = Math.abs(a[col][col]) < 1e-12 ? 0 : sum / a[col][col]
  }
  return x
}

export function forecastDhr(input: ForecastInput): number[] {
  const { train, trainHolidays, futureDates, futureHolidays, calendarHolidays } = input
  if (train.length === 0) return futureDates.map(() => 0)

  const trainStartZ = dayNumFromIso(train[0].date)
  const trainEndZ = dayNumFromIso(train[train.length - 1].date)
  const futureEndZ = futureDates.length > 0 ? dayNumFromIso(futureDates[futureDates.length - 1]) : trainEndZ

  // Holiday day numbers over the whole span. Prefer the full calendar set so
  // the holiday and post-holiday dummies get fit on open-on-holiday queues;
  // fall back to closure-derived sets when the caller supplies no calendar.
  const holidayZ = new Set<number>()
  const holidaySource =
    calendarHolidays !== undefined
      ? [calendarHolidays]
      : [trainHolidays, futureHolidays]
  for (const set of holidaySource) for (const d of set) holidayZ.add(dayNumFromIso(d))
  const ordinals = businessOrdinals(trainStartZ, futureEndZ, holidayZ)

  // Assemble training rows, excluding closed-holiday days.
  const rows: number[][] = []
  const targets: number[] = []
  for (const p of train) {
    if (trainHolidays.has(p.date)) continue
    rows.push(featureRow(dayNumFromIso(p.date), trainStartZ, holidayZ, ordinals))
    targets.push(p.total)
  }
  const nRows = rows.length
  if (nRows === 0) return futureDates.map(() => 0)
  const p = rows[0].length

  // Standardize columns; zero-variance columns become all-zero.
  const mean = new Array(p).fill(0)
  const std = new Array(p).fill(0)
  for (const row of rows) for (let j = 0; j < p; j++) mean[j] += row[j]
  for (let j = 0; j < p; j++) mean[j] /= nRows
  for (const row of rows) for (let j = 0; j < p; j++) std[j] += (row[j] - mean[j]) ** 2
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j] / nRows)
  const standardize = (row: number[]): number[] => {
    const out = new Array(p + 1)
    out[0] = 1 // intercept
    for (let j = 0; j < p; j++) out[j + 1] = std[j] > 0 ? (row[j] - mean[j]) / std[j] : 0
    return out
  }

  // Normal equations: (X'X + lambda * D) beta = X'y, D = I with D[0][0] = 0.
  const dim = p + 1
  const xtx: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0))
  const xty = new Array(dim).fill(0)
  for (let r = 0; r < nRows; r++) {
    const x = standardize(rows[r])
    const y = targets[r]
    for (let i = 0; i < dim; i++) {
      xty[i] += x[i] * y
      const xi = x[i]
      const rowI = xtx[i]
      for (let j = i; j < dim; j++) rowI[j] += xi * x[j]
    }
  }
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i]
  }
  for (let i = 1; i < dim; i++) xtx[i][i] += DHR_LAMBDA
  const beta = solveLinearSystem(xtx, xty)

  return futureDates.map((date) => {
    if (futureHolidays.has(date)) return 0
    const x = standardize(featureRow(dayNumFromIso(date), trainStartZ, holidayZ, ordinals))
    let yhat = 0
    for (let j = 0; j < dim; j++) yhat += beta[j] * x[j]
    return Math.max(0, yhat)
  })
}
