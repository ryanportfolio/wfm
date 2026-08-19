import type { BacktestReport, BacktestScore, IntervalRecord } from './types'
import type { ForecastInput } from './series'
import { addDays, groupQueueDays } from './series'
import { cleanDays } from './clean'
import { usHolidays } from './sampleData'
import { forecastEnsemble, COMPONENT_NAMES } from './forecast/ensemble'
import type { EnsembleOpts } from './forecast/ensemble'
import { buildProfiles, intervalize } from './profiles'
import { bias, mape, wape } from './metrics'

/**
 * Rolling-origin backtest: F folds (default 8), each training on all data up
 * to its origin and forecasting the next `horizonDays`. Folds step back by
 * `stepDays` (default = horizonDays, i.e. non-overlapping test windows).
 * Errors are pooled across folds per method, then scored at interval, daily,
 * and weekly grain against the raw (uncleaned) actuals.
 */

export interface BacktestOpts {
  folds?: number
  horizonDays?: number
  stepDays?: number
  ensemble?: EnsembleOpts
}

export const METHOD_NAMES = [...COMPONENT_NAMES, 'ensemble'] as const
export type MethodName = (typeof METHOD_NAMES)[number]

const MIN_TRAIN_DAYS = 140

/** BacktestScore plus the MAPE guard's scored-point fraction. */
export interface BacktestScoreDetailed extends BacktestScore {
  mapeCoverage: number
}

interface Pooled {
  actual: number[]
  forecast: number[]
}

function newPooled(): Pooled {
  return { actual: [], forecast: [] }
}

/** Build the ForecastInput for one training window ending before the horizon. */
export function buildFoldInput(
  cleanedDaily: { date: string; total: number; aht: number }[],
  closedHolidays: string[],
  holidayClosed: boolean,
  futureDates: string[],
): ForecastInput {
  const futureHolidays =
    holidayClosed && futureDates.length > 0
      ? new Set(usHolidays(futureDates[0], futureDates[futureDates.length - 1]))
      : new Set<string>()
  return {
    train: cleanedDaily,
    trainHolidays: new Set(closedHolidays),
    futureDates,
    futureHolidays,
  }
}

export function runBacktest(
  records: IntervalRecord[],
  queue: string,
  opts: BacktestOpts = {},
): BacktestReport[] {
  const folds = opts.folds ?? 8
  const horizonDays = opts.horizonDays ?? 28
  const stepDays = opts.stepDays ?? horizonDays
  const days = groupQueueDays(records, queue)

  const pooled: Record<MethodName, Record<'interval' | 'daily' | 'weekly', Pooled>> = {
    sma: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    hw: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    dhr: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    ensemble: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
  }

  let foldsRun = 0
  for (let f = 0; f < folds; f++) {
    const originIdx = days.length - horizonDays - f * stepDays
    if (originIdx < MIN_TRAIN_DAYS) break
    const trainDays = days.slice(0, originIdx)
    const testDays = days.slice(originIdx, originIdx + horizonDays)

    const cleaned = cleanDays(trainDays, queue)
    const input = buildFoldInput(
      cleaned.daily,
      cleaned.report.closedHolidays,
      cleaned.report.holidayClosed,
      testDays.map((d) => d.date),
    )
    const { components, blend } = forecastEnsemble(input, opts.ensemble)
    const profiles = buildProfiles(cleaned.days, new Set(cleaned.report.closedHolidays))

    const dailyByMethod: Record<MethodName, number[]> = { ...components, ensemble: blend }

    // Actual interval offered, keyed by ts, over the test window.
    const actualByTs = new Map<string, number>()
    for (const day of testDays) {
      for (const iv of day.intervals) actualByTs.set(`${day.date}T${iv.time}`, iv.offered)
    }

    for (const method of METHOD_NAMES) {
      const daily = dailyByMethod[method]

      // Interval grain: align on the union of forecast and actual timestamps.
      const points = intervalize(
        testDays.map((d, j) => ({ date: d.date, total: daily[j], aht: 0 })),
        profiles,
      )
      const seen = new Set<string>()
      for (const pt of points) {
        seen.add(pt.ts)
        pooled[method].interval.actual.push(actualByTs.get(pt.ts) ?? 0)
        pooled[method].interval.forecast.push(pt.offered)
      }
      for (const [ts, actual] of actualByTs) {
        if (!seen.has(ts)) {
          pooled[method].interval.actual.push(actual)
          pooled[method].interval.forecast.push(0)
        }
      }

      // Daily grain.
      for (let j = 0; j < testDays.length; j++) {
        pooled[method].daily.actual.push(testDays[j].total)
        pooled[method].daily.forecast.push(daily[j])
      }

      // Weekly grain: consecutive 7-day blocks from the forecast start.
      for (let w = 0; w * 7 < testDays.length; w++) {
        let act = 0
        let fc = 0
        for (let j = w * 7; j < Math.min((w + 1) * 7, testDays.length); j++) {
          act += testDays[j].total
          fc += daily[j]
        }
        pooled[method].weekly.actual.push(act)
        pooled[method].weekly.forecast.push(fc)
      }
    }
    foldsRun++
  }

  return METHOD_NAMES.map((method) => {
    const scores: BacktestScoreDetailed[] = (['interval', 'daily', 'weekly'] as const).map((grain) => {
      const { actual, forecast } = pooled[method][grain]
      const m = mape(actual, forecast)
      return {
        method,
        grain,
        wape: wape(actual, forecast),
        mape: m.mape,
        mapeCoverage: m.coverage,
        bias: bias(actual, forecast),
      }
    })
    return { queue, folds: foldsRun, horizonDays, scores }
  })
}

/** Future dates for a live forecast: the `horizonDays` days after the last training day. */
export function futureDatesAfter(lastDate: string, horizonDays: number): string[] {
  return Array.from({ length: horizonDays }, (_, j) => addDays(lastDate, j + 1))
}
