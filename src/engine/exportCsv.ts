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
 * - Schedule: two files. A shifts CSV (one row per shift, clock times) and an
 *   interval coverage CSV (required, target, scheduled, over, under agents).
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
import type { ScheduleResult, ScheduleRow, ShiftTemplate } from './schedule'
import { paidMinutes, SLOT_MINUTES, slotClock } from './schedule'

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

/**
 * Daily staffing summary. One row per forecast day.
 *
 * The cost column exists only when a cost-per-scheduled-hour rate is
 * configured (not as a permanent empty column): a file without the column
 * says "cost was off", a file with it says what rate multiplied the hours.
 * cost = scheduled_fte_hours * rate, nothing loaded on top.
 */
export function staffingDailyCsv(days: readonly StaffingDaySummary[], costPerHour?: number): string {
  const header = [
    'date',
    'weekday',
    'contacts',
    'required_fte_hours',
    'scheduled_fte_hours',
    'peak_on_phones',
    'service_level',
    'asa_sec',
    'abandon_rate',
  ]
  if (costPerHour !== undefined) header.push('cost')
  return toCsv(
    header,
    days.map((d) => {
      const row = [
        d.date,
        WEEKDAYS[weekdayOfIso(d.date)],
        csvNum(d.contacts),
        csvNum(d.requiredFte),
        csvNum(d.scheduledFte),
        csvNum(d.peakRequired),
        csvNum(d.sl),
        csvNum(d.asa),
        csvNum(d.abandon),
      ]
      if (costPerHour !== undefined) row.push(csvNum(d.scheduledFte * costPerHour))
      return row
    }),
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

/**
 * Built shifts, one row per shift in start order. Times are clock times
 * "HH:MM" on the schedule date (a shift ending at midnight reads 24:00).
 * Break columns repeat up to the most breaks any used template has; a shift
 * with fewer breaks or no lunch leaves those cells empty.
 */
export function scheduleShiftsCsv(result: ScheduleResult, templates: readonly ShiftTemplate[]): string {
  const dayStart = result.rows[0]?.ts ?? ''
  const byId = new Map(templates.map((t) => [t.id, t]))
  const used = result.shifts.map((sh) => {
    const t = byId.get(sh.templateId)
    if (!t) throw new Error(`Shift template "${sh.templateId}" is not in the template list`)
    return t
  })
  const breakCols = Math.max(0, ...used.map((t) => t.breaks.length))
  const header = ['date', 'shift', 'template', 'start', 'end', 'paid_hours']
  for (let b = 1; b <= breakCols; b++) header.push(`break_${b}_start`, `break_${b}_end`)
  header.push('lunch_start', 'lunch_end', 'lunch_paid')
  const clock = (slot: number) => slotClock(dayStart, slot)
  return toCsv(
    header,
    result.shifts.map((sh, i) => {
      const t = used[i]
      const row = [dayStart.slice(0, 10), String(i + 1), csvText(t.name), clock(sh.startSlot), clock(sh.endSlot), csvNum(paidMinutes(t) / 60)]
      for (let b = 0; b < breakCols; b++) {
        const at = sh.breakSlots[b]
        row.push(...(at === undefined ? ['', ''] : [clock(at), clock(at + t.breaks[b].minutes / SLOT_MINUTES)]))
      }
      if (t.lunch && sh.lunchSlot !== null) {
        row.push(clock(sh.lunchSlot), clock(sh.lunchSlot + t.lunch.minutes / SLOT_MINUTES), t.lunch.paid ? 'yes' : 'no')
      } else {
        row.push('', '', '')
      }
      return row
    }),
  )
}

/** Interval coverage of a built schedule, in agents: one row per interval. */
export function scheduleCoverageCsv(rows: readonly ScheduleRow[]): string {
  return toCsv(
    ['ts', 'required', 'target', 'scheduled', 'over', 'under'],
    rows.map((r) => [r.ts, csvNum(r.required), csvNum(r.target), csvNum(r.scheduled), csvNum(r.over), csvNum(r.under)]),
  )
}

/**
 * Free text as one CSV cell. A leading = + - @ tab or carriage return gets an
 * apostrophe prefix so spreadsheets show the text instead of running it as a
 * formula; the cell is quoted when it holds a comma, quote or line break.
 * Numbers go through csvNum, never here, so negative values are unaffected.
 */
export function csvText(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
