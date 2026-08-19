import type { BacktestReport, DailyPoint, ForecastPoint, IntervalRecord } from './types'
import type { CleanReport } from './clean'
import { cleanQueue } from './clean'
import type { EnsembleOpts, EnsembleWeights, ComponentName } from './forecast/ensemble'
import { forecastEnsemble } from './forecast/ensemble'
import { buildProfiles, intervalize } from './profiles'
import type { BacktestOpts } from './backtest'
import { buildFoldInput, futureDatesAfter, runBacktest as runBacktestImpl } from './backtest'

/**
 * Top-level forecast pipeline for one queue: clean, fit the three daily
 * components, blend them with per-horizon-bucket inverse-WAPE weights, and
 * intervalize via recency-weighted intraday profiles.
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
  /** Blended daily totals */
  ensemble: DailyPoint[]
  /** Fitted blend weights per horizon bucket, for UI display */
  weights: EnsembleWeights
  /** Alias for the ensemble daily forecast */
  dailyForecast: DailyPoint[]
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
  const cleaned = cleanQueue(records, queue)
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
  const { components, blend, weights } = forecastEnsemble(input, opts.ensemble)
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

  const ensembleDaily = toDaily(blend)
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
    dailyForecast: ensembleDaily,
    intervalForecast,
    ahtForecast,
  }
}

export function runBacktest(
  records: IntervalRecord[],
  queue: string,
  opts: BacktestOpts = {},
): BacktestReport[] {
  return runBacktestImpl(records, queue, opts)
}
