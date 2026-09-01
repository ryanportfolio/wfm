import type { BacktestReport, BacktestScore, IntervalRecord, RelErrorSample } from './types'
import type { ForecastInput } from './series'
import { addDays, groupQueueDays } from './series'
import { cleanDays } from './clean'
import { usHolidays } from './sampleData'
import { forecastEnsemble, COMPONENT_NAMES } from './forecast/ensemble'
import type { EnsembleOpts } from './forecast/ensemble'
import { bandQuantiles } from './intervals'
import { buildProfiles, intervalize } from './profiles'
import { bias, mape, relError, wape } from './metrics'

/**
 * Rolling-origin backtest: F folds (default 8), each training on all data up
 * to its origin and forecasting the next `horizonDays`. Folds step back by
 * `stepDays` (default = horizonDays, i.e. non-overlapping test windows).
 * Errors are pooled across folds per method, then scored at interval, daily,
 * and weekly grain against the raw (uncleaned) actuals.
 *
 * Beyond the pooled scores, each report also carries:
 * - foldDailyWape: one daily WAPE per fold, so fold-to-fold spread is visible;
 * - leadDayWape: daily WAPE per lead day pooled across folds (lead day 1 is
 *   the first forecast day after each fold's origin), for the accuracy-by-
 *   lead-time view;
 * - for the ensemble only, relErrors: every scored fold day's relative error
 *   (actual - forecast) / forecast, and bands: the ~80% empirical interval
 *   quantiles per horizon bucket built from them (see intervals.ts).
 */

export interface BacktestOpts {
  folds?: number
  horizonDays?: number
  stepDays?: number
  ensemble?: EnsembleOpts
}

// 'equal' is the unfitted 1/3-1/3-1/3 blend, scored as a benchmark so the
// scorecard shows whether the fitted ensemble weights earn their keep.
export const METHOD_NAMES = [...COMPONENT_NAMES, 'equal', 'ensemble'] as const
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
  const spanStart = cleanedDaily.length > 0 ? cleanedDaily[0].date : futureDates[0]
  const spanEnd = futureDates.length > 0 ? futureDates[futureDates.length - 1] : cleanedDaily[cleanedDaily.length - 1].date
  const calendarHolidays =
    spanStart !== undefined && spanEnd !== undefined
      ? new Set(usHolidays(spanStart, spanEnd))
      : new Set<string>()
  return {
    train: cleanedDaily,
    trainHolidays: new Set(closedHolidays),
    futureDates,
    futureHolidays,
    calendarHolidays,
  }
}

export function runBacktest(
  records: IntervalRecord[],
  queue: string,
  opts: BacktestOpts = {},
  /** Called before each fold runs: (1-based fold about to run, folds that will run). */
  onProgress?: (fold: number, totalFolds: number) => void,
): BacktestReport[] {
  const folds = opts.folds ?? 8
  const horizonDays = opts.horizonDays ?? 28
  const stepDays = opts.stepDays ?? horizonDays
  const days = groupQueueDays(records, queue)

  // How many of the requested folds actually fit the history, so progress
  // reads "fold 3 of 8" against the true total.
  let plannedFolds = 0
  while (
    plannedFolds < folds &&
    days.length - horizonDays - plannedFolds * stepDays >= MIN_TRAIN_DAYS
  ) {
    plannedFolds++
  }

  const pooled: Record<MethodName, Record<'interval' | 'daily' | 'weekly', Pooled>> = {
    sma: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    hw: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    dhr: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    equal: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
    ensemble: { interval: newPooled(), daily: newPooled(), weekly: newPooled() },
  }

  const newLead = () => new Array<number>(horizonDays).fill(0)
  // Per-lead-day absolute error per method; actual volume is method-independent.
  const leadAbsErr: Record<MethodName, number[]> = {
    sma: newLead(),
    hw: newLead(),
    dhr: newLead(),
    equal: newLead(),
    ensemble: newLead(),
  }
  const leadAbsAct = newLead()
  const foldWape: Record<MethodName, number[]> = { sma: [], hw: [], dhr: [], equal: [], ensemble: [] }
  const relErrors: RelErrorSample[] = []

  let foldsRun = 0
  for (let f = 0; f < folds; f++) {
    const originIdx = days.length - horizonDays - f * stepDays
    if (originIdx < MIN_TRAIN_DAYS) break
    onProgress?.(f + 1, plannedFolds)
    const trainDays = days.slice(0, originIdx)
    const testDays = days.slice(originIdx, originIdx + horizonDays)

    const cleaned = cleanDays(trainDays, queue)
    const input = buildFoldInput(
      cleaned.daily,
      cleaned.report.closedHolidays,
      cleaned.report.holidayClosed,
      testDays.map((d) => d.date),
    )
    // Raw (uncleaned) totals for the training window, so the inner weight
    // fit scores against the same kind of actuals the outer backtest uses.
    const rawTrainTotals = trainDays.map((d) => d.total)
    const { components, blend } = forecastEnsemble(input, opts.ensemble, rawTrainTotals)
    const profiles = buildProfiles(cleaned.days, new Set(cleaned.report.closedHolidays))

    const equal = components.sma.map(
      (v, j) => Math.max(0, (v + components.hw[j] + components.dhr[j]) / 3),
    )
    const dailyByMethod: Record<MethodName, number[]> = { ...components, equal, ensemble: blend }

    // Actual interval offered, keyed by ts, over the test window.
    const actualByTs = new Map<string, number>()
    for (const day of testDays) {
      for (const iv of day.intervals) actualByTs.set(`${day.date}T${iv.time}`, iv.offered)
    }

    // Pooled actual volume per lead day (shared across methods).
    for (let j = 0; j < testDays.length; j++) leadAbsAct[j] += Math.abs(testDays[j].total)

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

      // Daily grain, plus per-lead-day and fold-level records. testDays[j]
      // is lead day j + 1: the (j + 1)-th day after this fold's origin.
      const foldActual: number[] = []
      const foldForecast: number[] = []
      for (let j = 0; j < testDays.length; j++) {
        const act = testDays[j].total
        const fc = daily[j]
        pooled[method].daily.actual.push(act)
        pooled[method].daily.forecast.push(fc)
        foldActual.push(act)
        foldForecast.push(fc)
        leadAbsErr[method][j] += Math.abs(fc - act)
        if (method === 'ensemble') {
          const rel = relError(act, fc)
          if (rel !== null) relErrors.push({ lead: j + 1, rel })
        }
      }
      foldWape[method].push(wape(foldActual, foldForecast))

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

  // No fold fit (history shorter than MIN_TRAIN_DAYS + horizon): report zero
  // folds with no scores instead of NaN metrics over empty arrays.
  if (foldsRun === 0) {
    return METHOD_NAMES.map(() => ({ queue, folds: 0, horizonDays, scores: [] }))
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
    const report: BacktestReport = {
      queue,
      folds: foldsRun,
      horizonDays,
      scores,
      leadDayWape: leadAbsAct.map((act, j) =>
        act > 0 ? leadAbsErr[method][j] / act : Number.NaN,
      ),
      foldDailyWape: foldWape[method],
    }
    if (method === 'ensemble') {
      report.relErrors = relErrors
      report.bands = bandQuantiles(relErrors) ?? undefined
    }
    return report
  })
}

/** Future dates for a live forecast: the `horizonDays` days after the last training day. */
export function futureDatesAfter(lastDate: string, horizonDays: number): string[] {
  return Array.from({ length: horizonDays }, (_, j) => addDays(lastDate, j + 1))
}
