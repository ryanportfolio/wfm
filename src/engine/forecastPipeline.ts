import type {
  BacktestReport,
  BandQuantiles,
  BandedDailyPoint,
  DailyPoint,
  ForecastPoint,
  IntervalRecord,
} from './types'
import type { CleanReport } from './clean'
import { cleanDays } from './clean'
import { groupQueueDays } from './series'
import type { EnsembleOpts, EnsembleWeights, ComponentName } from './forecast/ensemble'
import { forecastEnsemble } from './forecast/ensemble'
import { bandForDay, bandQuantiles } from './intervals'
import { buildProfiles, intervalize } from './profiles'
import type { BacktestOpts } from './backtest'
import { buildFoldInput, futureDatesAfter, runBacktest as runBacktestImpl } from './backtest'

/**
 * Top-level forecast pipeline for one queue: clean, fit the three daily
 * components, blend them with per-horizon-bucket inverse-WAPE weights, and
 * intervalize via recency-weighted intraday profiles.
 *
 * The ensemble daily forecast carries an ~80% prediction band (lo/hi per
 * day). It is calibrated from the ensemble's own inner rolling-origin fold
 * errors (see intervals.ts), which the weight fit already computes, so the
 * band shows by default at zero extra model runs; no manual backtest step is
 * needed. Tradeoff, documented in ensemble.ts: those errors are slightly
 * in-sample for the blend (the weights were tuned on them), so the band can
 * read a little narrower than outer backtest errors would make it. The outer
 * backtest records its own error pool on the ensemble report for comparison.
 */

export interface ForecastOpts {
  horizonDays?: number
  ensemble?: EnsembleOpts
}

export interface AhtForecastPoint {
  ts: string
  aht: number
}

export interface ForecastResult {
  queue: string
  cleanReport: CleanReport
  /** Daily totals per component over the horizon */
  components: Record<ComponentName, DailyPoint[]>
  /** Blended daily totals with 80% band edges */
  ensemble: BandedDailyPoint[]
  /** Fitted blend weights per horizon bucket, for UI display */
  weights: EnsembleWeights
  /**
   * 80% band quantiles per horizon bucket from the ensemble's inner fold
   * errors; null when history is too short to calibrate (band hidden, points
   * carry lo = hi = total).
   */
  band: BandQuantiles[] | null
  /** Alias for the ensemble daily forecast */
  dailyForecast: BandedDailyPoint[]
  /** Ensemble intervalized: offered and AHT per interval */
  intervalForecast: ForecastPoint[]
  /** AHT forecast per interval */
  ahtForecast: AhtForecastPoint[]
}

export function runForecast(
  records: IntervalRecord[],
  queue: string,
  opts: ForecastOpts = {},
): ForecastResult {
  const horizonDays = opts.horizonDays ?? 28
  const rawDays = groupQueueDays(records, queue)
  const cleaned = cleanDays(rawDays, queue)
  if (cleaned.daily.length === 0) {
    throw new Error(`runForecast: no records for queue "${queue}"`)
  }
  const futureDates = futureDatesAfter(cleaned.daily[cleaned.daily.length - 1].date, horizonDays)
  const input = buildFoldInput(
    cleaned.daily,
    cleaned.report.closedHolidays,
    cleaned.report.holidayClosed,
    futureDates,
  )
  // Raw daily totals (same dates as cleaned.daily) so the ensemble's inner
  // evaluation scores against uncleaned actuals like the backtest does.
  const rawTrainTotals = rawDays.map((d) => d.total)
  const { components, blend, weights } = forecastEnsemble(input, opts.ensemble, rawTrainTotals)
  const profiles = buildProfiles(cleaned.days, new Set(cleaned.report.closedHolidays))

  const intervalForecast = intervalize(
    futureDates.map((date, j) => ({ date, total: blend[j], aht: 0 })),
    profiles,
  )
  const ahtForecast: AhtForecastPoint[] = intervalForecast.map((p) => ({ ts: p.ts, aht: p.aht }))

  // Daily AHT: profile-weighted mean per day, shared across methods.
  const dailyAht = new Map<string, number>()
  {
    let date = ''
    let num = 0
    let den = 0
    for (const p of intervalForecast) {
      const d = p.ts.slice(0, 10)
      if (d !== date) {
        if (date !== '') dailyAht.set(date, den > 0 ? num / den : 0)
        date = d
        num = 0
        den = 0
      }
      num += p.offered * p.aht
      den += p.offered
    }
    if (date !== '') dailyAht.set(date, den > 0 ? num / den : 0)
  }
  const toDaily = (values: number[]): DailyPoint[] =>
    futureDates.map((date, j) => ({ date, total: values[j], aht: dailyAht.get(date) ?? 0 }))

  const band = bandQuantiles(weights.innerErrors)
  const ensembleDaily: BandedDailyPoint[] = futureDates.map((date, j) => {
    const total = blend[j]
    const { lo, hi } = band ? bandForDay(total, j + 1, band) : { lo: total, hi: total }
    return { date, total, aht: dailyAht.get(date) ?? 0, lo, hi }
  })
  return {
    queue,
    cleanReport: cleaned.report,
    components: {
      sma: toDaily(components.sma),
      hw: toDaily(components.hw),
      dhr: toDaily(components.dhr),
    },
    ensemble: ensembleDaily,
    weights,
    band,
    dailyForecast: ensembleDaily,
    intervalForecast,
    ahtForecast,
  }
}

export function runBacktest(
  records: IntervalRecord[],
  queue: string,
  opts: BacktestOpts = {},
  onProgress?: (fold: number, totalFolds: number) => void,
): BacktestReport[] {
  return runBacktestImpl(records, queue, opts, onProgress)
}
