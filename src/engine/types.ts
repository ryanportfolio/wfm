export interface IntervalRecord {
  /** Interval start, ISO local, e.g. "2026-08-16T09:30:00" */
  ts: string
  /** Queue/skill name */
  queue: string
  /** Contacts offered in the interval */
  offered: number
  /** Average handle time for the interval, seconds (0 when offered is 0) */
  aht: number
}

export interface DailyPoint {
  /** ISO date, e.g. "2026-08-16" */
  date: string
  /** Total offered for the day */
  total: number
  /** AHT-weighted daily mean, seconds */
  aht: number
}

export interface DailySeries {
  queue: string
  points: DailyPoint[]
}

export interface IntradayProfile {
  queue: string
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number
  /** One share per interval of the day, summing to 1 */
  shares: number[]
}

export interface ForecastPoint {
  ts: string
  offered: number
  aht: number
}

export interface Forecast {
  queue: string
  method: string
  daily: DailyPoint[]
  intervals: ForecastPoint[]
}

export interface BacktestScore {
  method: string
  grain: 'interval' | 'daily' | 'weekly'
  wape: number
  mape: number
  bias: number
}

export interface BacktestReport {
  queue: string
  folds: number
  horizonDays: number
  scores: BacktestScore[]
}

export interface StaffingInterval {
  ts: string
  queue: string
  /** Agents required on the phones (Erlang) */
  required: number
  /** Bodies to schedule after shrinkage gross-up */
  scheduled: number
  occupancy: number
  serviceLevel: number
  asa: number
  abandonRate: number
}

export interface StaffingGrid {
  queue: string
  intervals: StaffingInterval[]
}
