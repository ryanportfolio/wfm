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

export interface ForecastPoint {
  ts: string
  offered: number
  aht: number
}

export interface BacktestScore {
  method: string
  grain: 'interval' | 'daily' | 'weekly'
  wape: number
  mape: number
  bias: number
}

/** One scored fold day kept for interval construction. */
export interface RelErrorSample {
  /** 1-based lead day: 1 = the first forecast day after the fold origin */
  lead: number
  /** (actual - forecast) / forecast for that day; see relError in metrics.ts */
  rel: number
}

/** Empirical 80% prediction-band multipliers for one horizon bucket. */
export interface BandQuantiles {
  label: string
  /** 1-based first lead day the bucket covers (inclusive) */
  fromDay: number
  /** 1-based last lead day the bucket covers (inclusive) */
  toDay: number
  /** Number of pooled error samples behind the quantiles */
  samples: number
  /** 10th percentile of relative error, clamped to <= 0 */
  qLo: number
  /** 90th percentile of relative error, clamped to >= 0 */
  qHi: number
}

/** Daily forecast point with its 80% band edges. */
export interface BandedDailyPoint extends DailyPoint {
  /** Lower band edge; equals total when no band could be calibrated */
  lo: number
  /** Upper band edge; equals total when no band could be calibrated */
  hi: number
}

export interface BacktestReport {
  queue: string
  folds: number
  horizonDays: number
  scores: BacktestScore[]
  /**
   * Pooled daily WAPE per lead day across folds; index 0 = lead day 1.
   * NaN for a lead day with zero pooled actual volume. Absent when no fold ran.
   */
  leadDayWape?: number[]
  /** This method's daily WAPE per fold, most recent fold origin first. Absent when no fold ran. */
  foldDailyWape?: number[]
  /** Ensemble report only: relative daily errors from every fold day, for interval construction */
  relErrors?: RelErrorSample[]
  /** Ensemble report only: 80% band quantiles per horizon bucket, from relErrors */
  bands?: BandQuantiles[]
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
  /**
   * Fixed-staff mode, Erlang C only: bodies on phones <= offered load, so the
   * steady-state queue grows without bound. Absent in staff-to-target mode.
   */
  unstable?: boolean
}

export interface StaffingGrid {
  queue: string
  intervals: StaffingInterval[]
}
