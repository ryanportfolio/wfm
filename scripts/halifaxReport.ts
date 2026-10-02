// Recomputes every figure in docs/backtest-halifax.md from the committed
// Halifax 311 CSV with the app's own engine. Used by the CLI
// (scripts/halifax-backtest.ts) and by the figure-pin test.
//
// Same entry points and options as the app: parseCsv (Upload CSV),
// analyzeDataQuality (Data tab completeness), runForecast with a 28-day
// horizon (Data tab cleaning report, which does not depend on the horizon, and
// the Forecast tab blend weights), and runBacktest with 8 folds x 28 days
// (Accuracy tab).

import { parseCsv } from '../src/engine/csv'
import { analyzeDataQuality } from '../src/engine/dataQuality'
import { runBacktest, runForecast } from '../src/engine/forecastPipeline'
import { buildFoldInput, METHOD_NAMES } from '../src/engine/backtest'
import type { BacktestScoreDetailed, MethodName } from '../src/engine/backtest'
import { cleanDays } from '../src/engine/clean'
import { forecastEnsemble } from '../src/engine/forecast/ensemble'
import { wape } from '../src/engine/metrics'
import { groupQueueDays } from '../src/engine/series'
import { fmtInt, fmtPct, fmtSignedPct } from '../src/ui/format'

const HALIFAX_CSV = 'public/data/halifax-311.csv'
const QUEUE = 'halifax-311'
const FOLDS = 8
const HORIZON = 28
const GRAINS = ['interval', 'daily', 'weekly'] as const
type Grain = (typeof GRAINS)[number]

export const METHOD_LABELS: Record<MethodName, string> = {
  sma: 'SMA',
  hw: 'Holt-Winters',
  dhr: 'DHR',
  equal: 'Equal-weight blend',
  ensemble: 'Ensemble',
}

export interface HalifaxReport {
  /** Section title plus markdown block; every block appears verbatim in the write-up. */
  sections: { title: string; body: string }[]
  score: (method: MethodName, grain: Grain) => BacktestScoreDetailed
  /** Daily WAPE per method over the test days that had calls. */
  dailyWapeOpenDays: Record<MethodName, number>
  /** Named figures the write-up's prose quotes, e.g. `bias.sma.F7` or `test.monthMax`. */
  facts: Record<string, number>
}

const row = (cells: string[]) => `| ${cells.join(' | ')} |`

export function buildHalifaxReport(csvText: string): HalifaxReport {
  const { records, errors, rejected } = parseCsv(csvText)
  if (errors.length > 0 || rejected) {
    throw new Error(`${HALIFAX_CSV}: ${errors.length} parse errors, first: ${JSON.stringify(errors[0])}`)
  }
  const days = groupQueueDays(records, QUEUE)
  const total = days.reduce((s, d) => s + d.total, 0)
  const sections: HalifaxReport['sections'] = []
  const facts: Record<string, number> = {}

  // Mean agent-queue calls a day over the days of `month` that fall in [from, to].
  const monthMean = (month: string, from = days[0].date, to = days[days.length - 1].date) => {
    const ds = days.filter((d) => d.date.startsWith(month) && d.date >= from && d.date <= to)
    return ds.reduce((s, d) => s + d.total, 0) / ds.length
  }
  let talk = 0
  for (const r of records) talk += r.offered * r.aht
  Object.assign(facts, {
    'csv.rows': records.length,
    'csv.days': days.length,
    'csv.years': days.length / 365.25,
    'csv.megabytes': csvText.length / 1e6,
    'csv.ahtMean': talk / total,
    'csv.apr2019': monthMean('2019-04'),
    'csv.apr2020': monthMean('2020-04'),
    'csv.jan2023': monthMean('2023-01'),
  })

  sections.push({
    title: 'Data',
    body: [
      `- Rows parsed: ${fmtInt(records.length)}, parse errors: 0`,
      `- Range: ${days[0].date} to ${days[days.length - 1].date} (${fmtInt(days.length)} days)`,
      `- Agent-queue calls: ${fmtInt(total)}`,
    ].join('\n'),
  })

  const [quality] = analyzeDataQuality(records)
  facts['csv.missingSlots'] = quality.missingSlots.count
  sections.push({
    title: 'Completeness (Data tab)',
    body: [
      row(['Missing dates', 'Missing expected slots', 'Explicit zero rows']),
      '|---:|---:|---:|',
      row([fmtInt(quality.missingDates.count), fmtInt(quality.missingSlots.count), fmtInt(quality.zeroRows)]),
    ].join('\n'),
  })

  const forecast = runForecast(records, QUEUE, { horizonDays: HORIZON })
  const clean = forecast.cleanReport
  facts['holidays.total'] = clean.holidays.length
  facts['holidays.closed'] = clean.closedHolidays.length
  sections.push({
    title: 'Cleaning report (Data tab, full history)',
    body: [
      `- Interval outliers: ${fmtInt(clean.flaggedIntervals.length)}`,
      `- Daily outliers: ${fmtInt(clean.flaggedDays.length)}`,
      `- US federal holiday dates in range: ${clean.holidays.length}, of which zero-volume (closed): ${clean.closedHolidays.length}`,
      `- Holiday mode: ${clean.holidayClosed ? 'closed on holidays' : 'open on holidays'}`,
    ].join('\n'),
  })

  const reports = runBacktest(records, QUEUE, { folds: FOLDS, horizonDays: HORIZON })
  const folds = reports[0].folds
  const score = (method: MethodName, grain: Grain) =>
    reports[METHOD_NAMES.indexOf(method)].scores.find((s) => s.grain === grain) as BacktestScoreDetailed
  const scorecard = [
    row(['Method', ...GRAINS.map((g) => `WAPE ${g}`), ...GRAINS.map((g) => `MAPE ${g}`), ...GRAINS.map((g) => `Bias ${g}`)]),
    `|---|${Array(9).fill('---:').join('|')}|`,
    ...METHOD_NAMES.map((m) =>
      row([
        METHOD_LABELS[m],
        ...GRAINS.map((g) => fmtPct(score(m, g).wape)),
        ...GRAINS.map((g) => fmtPct(score(m, g).mape)),
        ...GRAINS.map((g) => fmtSignedPct(score(m, g).bias)),
      ]),
    ),
    '',
    `MAPE coverage (points with nonzero actuals): ${GRAINS.map((g) => `${g} ${fmtPct(score('ensemble', g).mapeCoverage)}`).join(', ')}.`,
  ].join('\n')
  const testFrom = days[days.length - HORIZON * folds].date
  const testTo = days[days.length - 1].date
  sections.push({
    title: `Scorecard (${folds} folds x ${HORIZON} days, test days ${testFrom} to ${testTo})`,
    body: scorecard,
  })
  for (const m of METHOD_NAMES) {
    for (const g of GRAINS) {
      facts[`wape.${m}.${g}`] = score(m, g).wape
      facts[`mape.${m}.${g}`] = score(m, g).mape
      facts[`bias.${m}.${g}`] = score(m, g).bias
    }
  }
  for (const g of GRAINS) facts[`coverage.${g}`] = score('ensemble', g).mapeCoverage
  // Calendar-month means clipped to the test period, so a month the test
  // period only partly covers counts only its tested days.
  const testMonths = [...new Set(days.filter((d) => d.date >= testFrom).map((d) => d.date.slice(0, 7)))]
  const testMonthMeans = testMonths.map((m) => monthMean(m, testFrom, testTo))
  facts['test.monthMin'] = Math.min(...testMonthMeans)
  facts['test.monthMax'] = Math.max(...testMonthMeans)

  const windows = Array.from({ length: folds }, (_, f) => {
    const start = days.length - HORIZON - f * HORIZON
    return `F${f + 1} ${days[start].date} to ${days[start + HORIZON - 1].date}`
  })
  sections.push({
    title: 'Daily WAPE per fold (F1 = most recent)',
    body: [
      row(['Method', ...windows.map((_, f) => `F${f + 1}`)]),
      `|---|${windows.map(() => '---:').join('|')}|`,
      ...METHOD_NAMES.map((m, i) => row([METHOD_LABELS[m], ...reports[i].foldDailyWape!.map((w) => fmtPct(w))])),
      '',
      `Test windows: ${windows.join('; ')}.`,
    ].join('\n'),
  })

  METHOD_NAMES.forEach((m, i) => reports[i].foldDailyWape!.forEach((w, f) => (facts[`foldWape.${m}.F${f + 1}`] = w)))

  const leadMean = (i: number, from: number, to: number) => {
    const xs = reports[i].leadDayWape!.slice(from - 1, to)
    return xs.reduce((a, b) => a + b, 0) / xs.length
  }
  METHOD_NAMES.forEach((m, i) => {
    facts[`lead.${m}.1-7`] = leadMean(i, 1, 7)
    facts[`lead.${m}.8-14`] = leadMean(i, 8, 14)
    facts[`lead.${m}.15-28`] = leadMean(i, 15, 28)
  })
  for (const b of forecast.weights.buckets) {
    for (const c of ['sma', 'hw', 'dhr'] as const) facts[`weight.${b.label}.${c}`] = b.weights[c]
  }
  sections.push({
    title: 'Mean daily WAPE by lead time',
    body: [
      row(['Method', 'Days 1-7', 'Days 8-14', 'Days 15-28']),
      '|---|---:|---:|---:|',
      ...METHOD_NAMES.map((m, i) =>
        row([METHOD_LABELS[m], fmtPct(leadMean(i, 1, 7)), fmtPct(leadMean(i, 8, 14)), fmtPct(leadMean(i, 15, 28))]),
      ),
    ].join('\n'),
  })

  sections.push({
    title: 'Ensemble weights fitted on the full history (Forecast tab, 28-day horizon)',
    body: [
      row(['Horizon', 'SMA', 'Holt-Winters', 'DHR']),
      '|---|---:|---:|---:|',
      ...forecast.weights.buckets.map((b) =>
        row([b.label, fmtPct(b.weights.sma, 0), fmtPct(b.weights.hw, 0), fmtPct(b.weights.dhr, 0)]),
      ),
    ].join('\n'),
  })

  // Replay the backtest's daily grain fold by fold and check it matches
  // runBacktest. The replay gives per-fold bias, and daily WAPE without the
  // zero-call days: the engine's holiday calendar is US federal, so Halifax
  // closures are forecast as open days.
  const actual: number[] = []
  const predicted: Record<MethodName, number[]> = { sma: [], hw: [], dhr: [], equal: [], ensemble: [] }
  const closed: string[] = []
  const foldBias: Record<MethodName, number[]> = { sma: [], hw: [], dhr: [], equal: [], ensemble: [] }
  const foldActualPerDay: number[] = []
  const foldPriorPerDay: number[] = []
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  for (let f = 0; f < folds; f++) {
    const originIdx = days.length - HORIZON - f * HORIZON
    const train = days.slice(0, originIdx)
    const test = days.slice(originIdx, originIdx + HORIZON)
    const cleaned = cleanDays(train, QUEUE)
    const input = buildFoldInput(cleaned.daily, cleaned.report.closedHolidays, cleaned.report.holidayClosed, test.map((d) => d.date))
    const { components, blend } = forecastEnsemble(input, undefined, train.map((d) => d.total))
    const equal = components.sma.map((v, j) => Math.max(0, (v + components.hw[j] + components.dhr[j]) / 3))
    const byMethod: Record<MethodName, number[]> = { ...components, equal, ensemble: blend }
    for (const d of test) {
      actual.push(d.total)
      if (d.total === 0) closed.push(d.date)
    }
    for (const m of METHOD_NAMES) predicted[m].push(...byMethod[m])
    const testTotal = sum(test.map((d) => d.total))
    for (const m of METHOD_NAMES) foldBias[m].push((sum(byMethod[m]) - testTotal) / testTotal)
    foldActualPerDay.push(testTotal / HORIZON)
    foldPriorPerDay.push(sum(train.slice(-56).map((d) => d.total)) / 56)
  }
  sections.push({
    title: 'Daily bias per fold (F1 = most recent)',
    body: [
      row(['Method', ...foldBias.sma.map((_, f) => `F${f + 1}`)]),
      `|---|${foldBias.sma.map(() => '---:').join('|')}|`,
      ...METHOD_NAMES.map((m) => row([METHOD_LABELS[m], ...foldBias[m].map((b) => fmtSignedPct(b))])),
      row(['Actual calls a day', ...foldActualPerDay.map((v) => fmtInt(v))]),
      row(['Calls a day, 8 weeks before origin', ...foldPriorPerDay.map((v) => fmtInt(v))]),
    ].join('\n'),
  })
  const keep = actual.map((a) => a > 0)
  const dailyWapeOpenDays = {} as Record<MethodName, number>
  const openRows = METHOD_NAMES.map((m) => {
    const all = wape(actual, predicted[m])
    if (Math.abs(all - score(m, 'daily').wape) > 1e-12) {
      throw new Error(`${m}: replayed daily WAPE ${all} differs from runBacktest ${score(m, 'daily').wape}`)
    }
    const open = wape(actual.filter((_, j) => keep[j]), predicted[m].filter((_, j) => keep[j]))
    dailyWapeOpenDays[m] = open
    return row([METHOD_LABELS[m], fmtPct(all), fmtPct(open)])
  })
  sections.push({
    title: `Daily WAPE without the ${closed.length} zero-call test days`,
    body: [
      row(['Method', 'All test days', 'Zero-call days removed']),
      '|---|---:|---:|',
      ...openRows,
      '',
      `Zero-call test days: ${closed.sort().join(', ')}.`,
    ].join('\n'),
  })

  METHOD_NAMES.forEach((m) => {
    foldBias[m].forEach((b, f) => (facts[`foldBias.${m}.F${f + 1}`] = b))
    facts[`open.${m}`] = dailyWapeOpenDays[m]
  })
  foldActualPerDay.forEach((v, f) => (facts[`actual.F${f + 1}`] = v))
  foldPriorPerDay.forEach((v, f) => (facts[`prior.F${f + 1}`] = v))
  facts['zeroCallDays'] = closed.length

  return { sections, score, dailyWapeOpenDays, facts }
}
