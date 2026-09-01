/**
 * Pure CSV builders behind the download buttons.
 *
 * Shapes chosen:
 * - Forecast: two files. A daily CSV (one row per day: ensemble total, 80%
 *   band edges, daily AHT) and an intraday CSV (one row per interval).
 *   Mixing the two grains in one file would force blank columns, so each
 *   grain gets its own file.
 * - Staffing: two files per scenario. An interval CSV (one row per interval
 *   with the scenario-scaled offered/AHT next to the solved staffing numbers)
 *   and a daily summary CSV matching the on-screen table.
 * - Scorecard: one wide CSV, one row per method: WAPE/MAPE/bias at interval,
 *   daily, and weekly grain, then WAPE per lead day.
 *
 * Values keep up to 6 decimals (analyst data, not display rounding). Rates
 * are fractions (0.8 = 80% service level), never percent strings. Dates and
 * timestamps stay ISO. Non-finite values (e.g. ASA at zero volume) become
 * empty cells.
 */
import type {
  BacktestReport,
  BandedDailyPoint,
  ForecastPoint,
  StaffingInterval,
} from './types'
import { weekdayOfIso } from './series'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Up to 6 decimals, trailing zeros dropped; empty cell for non-finite. */
export function csvNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  return String(Number(v.toFixed(6)))
}

function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n'
}

/** Daily ensemble forecast with the 80% band. One row per forecast day. */
export function forecastDailyCsv(daily: readonly BandedDailyPoint[]): string {
  return toCsv(
    ['date', 'weekday', 'forecast_offered', 'lo80', 'hi80', 'aht_sec'],
    daily.map((p) => [
      p.date,
      WEEKDAYS[weekdayOfIso(p.date)],
      csvNum(p.total),
      csvNum(p.lo),
      csvNum(p.hi),
      csvNum(p.aht),
    ]),
  )
}

/** Intraday ensemble forecast. One row per 30-minute interval. */
export function forecastIntervalCsv(points: readonly ForecastPoint[]): string {
  return toCsv(
    ['date', 'interval_start', 'forecast_offered', 'aht_sec'],
    points.map((p) => [p.ts.slice(0, 10), p.ts.slice(11, 16), csvNum(p.offered), csvNum(p.aht)]),
  )
}

/**
 * Per-interval staffing grid. `scaledForecast` is the interval forecast after
 * the scenario's volume and AHT deltas, parallel to `intervals`; rates are
 * fractions, ASA in seconds.
 */
export function staffingIntervalCsv(
  intervals: readonly StaffingInterval[],
  scaledForecast: readonly { offered: number; aht: number }[],
): string {
  return toCsv(
    [
      'date',
      'interval_start',
      'offered',
      'aht_sec',
      'required_agents',
      'scheduled_agents',
      'occupancy',
      'service_level',
      'asa_sec',
      'abandon_rate',
    ],
    intervals.map((iv, i) => [
      iv.ts.slice(0, 10),
      iv.ts.slice(11, 16),
      csvNum(scaledForecast[i]?.offered ?? Number.NaN),
      csvNum(scaledForecast[i]?.aht ?? Number.NaN),
      csvNum(iv.required),
      csvNum(iv.scheduled),
      csvNum(iv.occupancy),
      csvNum(iv.serviceLevel),
      csvNum(iv.asa),
      csvNum(iv.abandonRate),
    ]),
  )
}

/** One daily-summary row, matching the staffing tab's daily table. */
export interface StaffingDaySummary {
  date: string
  contacts: number
  requiredFte: number
  scheduledFte: number
  peakRequired: number
  /** Volume-weighted service level, fraction */
  sl: number
  /** Volume-weighted ASA, seconds */
  asa: number
  /** Volume-weighted abandon rate, fraction */
  abandon: number
}

/** Daily staffing summary. One row per forecast day. */
export function staffingDailyCsv(days: readonly StaffingDaySummary[]): string {
  return toCsv(
    [
      'date',
      'weekday',
      'contacts',
      'required_fte_hours',
      'scheduled_fte_hours',
      'peak_on_phones',
      'service_level',
      'asa_sec',
      'abandon_rate',
    ],
    days.map((d) => [
      d.date,
      WEEKDAYS[weekdayOfIso(d.date)],
      csvNum(d.contacts),
      csvNum(d.requiredFte),
      csvNum(d.scheduledFte),
      csvNum(d.peakRequired),
      csvNum(d.sl),
      csvNum(d.asa),
      csvNum(d.abandon),
    ]),
  )
}

const SCORE_GRAINS = ['interval', 'daily', 'weekly'] as const

/**
 * Backtest scorecard: one row per method. WAPE/MAPE/bias per grain as
 * fractions, then pooled daily WAPE per lead day (empty cell where no pooled
 * actual volume exists).
 */
export function scorecardCsv(reports: readonly BacktestReport[]): string {
  const horizon = reports[0]?.horizonDays ?? 0
  const leadCols = Array.from({ length: horizon }, (_, j) => `wape_lead_day_${j + 1}`)
  const header = [
    'method',
    ...SCORE_GRAINS.map((g) => `wape_${g}`),
    ...SCORE_GRAINS.map((g) => `mape_${g}`),
    ...SCORE_GRAINS.map((g) => `bias_${g}`),
    ...leadCols,
  ]
  const rows = reports.map((r) => {
    const method = r.scores[0]?.method ?? ''
    const byGrain = new Map(r.scores.map((s) => [s.grain, s]))
    const cell = (metric: 'wape' | 'mape' | 'bias', grain: (typeof SCORE_GRAINS)[number]) => {
      const s = byGrain.get(grain)
      return s ? csvNum(s[metric]) : ''
    }
    return [
      method,
      ...SCORE_GRAINS.map((g) => cell('wape', g)),
      ...SCORE_GRAINS.map((g) => cell('mape', g)),
      ...SCORE_GRAINS.map((g) => cell('bias', g)),
      ...Array.from({ length: horizon }, (_, j) => csvNum(r.leadDayWape?.[j] ?? Number.NaN)),
    ]
  })
  return toCsv(header, rows)
}
