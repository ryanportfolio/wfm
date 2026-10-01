import { beforeAll, describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import type { BacktestReport, IntervalRecord } from './engine/types'
import { generateSampleData } from './engine/sampleData'
import { runBacktest } from './engine/forecastPipeline'
import { buildCapacityPlan } from './engine/capacity'
import { capacityConfig, exampleCapacityState } from './ui/capacityState'
import { fmtPct } from './ui/format'
import { ACCURACY_BACKTEST_OPTS } from './ui/workerClient'

/**
 * Pins every README figure computed from the generated sample data or from a
 * deterministic example the README describes. Each test parses the figure out
 * of README.md and compares it with a fresh computation formatted the way the
 * UI displays it, so changing either side alone fails here.
 */

/** Capture groups of `pattern` in the README; fails loudly when phrasing changed. */
function readmeMatch(pattern: RegExp, what: string): string[] {
  const m = readme.match(pattern)
  if (!m) {
    throw new Error(
      `README.md no longer matches the pattern for ${what}: ${pattern}. ` +
        'Update this test together with the README wording.',
    )
  }
  return m.slice(1)
}

let records: IntervalRecord[]
let largestQueue: string
let reports: BacktestReport[]

beforeAll(() => {
  records = generateSampleData()
  const totals = new Map<string, number>()
  for (const r of records) totals.set(r.queue, (totals.get(r.queue) ?? 0) + r.offered)
  largestQueue = [...totals].sort((a, b) => b[1] - a[1])[0][0]
  reports = runBacktest(records, largestQueue, ACCURACY_BACKTEST_OPTS)
})

function dailyWape(method: string): number {
  const report = reports.find((r) => r.scores[0]?.method === method)
  const score = report?.scores.find((s) => s.grain === 'daily')
  if (!score) throw new Error(`no daily score for ${method}`)
  return score.wape
}

describe('README sample-data figures', () => {
  it('describes the sample dataset shape', () => {
    const [years, queues, minutes] = readmeMatch(
      /"Load sample data" \((\d+) years, (\d+) queues, (\d+)-minute intervals\)/,
      'the sample dataset shape',
    )
    const dates = [...new Set(records.map((r) => r.ts.slice(0, 10)))]
    expect(String(dates.length / 365)).toBe(years)
    expect(String(new Set(records.map((r) => r.queue)).size)).toBe(queues)
    const first = records.filter((r) => r.queue === records[0].queue && r.ts.startsWith(dates[0]))
    const stepMinutes = (Date.parse(`${first[1].ts}Z`) - Date.parse(`${first[0].ts}Z`)) / 60_000
    expect(String(stepMinutes)).toBe(minutes)
  })

  it('states the fold count and horizon the Accuracy tab runs', () => {
    const [folds, horizon] = readmeMatch(
      /Rolling-origin backtest \((\d+) folds, (\d+)-day horizon/,
      'the backtest folds and horizon',
    )
    expect(String(ACCURACY_BACKTEST_OPTS.folds)).toBe(folds)
    expect(String(ACCURACY_BACKTEST_OPTS.horizonDays)).toBe(horizon)
    // Every requested fold fits the sample history.
    for (const report of reports) {
      expect(String(report.folds)).toBe(folds)
      expect(String(report.horizonDays)).toBe(horizon)
    }
  })

  it('quotes the daily WAPE scorecard for the largest queue', () => {
    const [queue, ...quoted] = readmeMatch(
      /Sample-data result for the largest queue \(`([\w-]+)`\), daily WAPE: seasonal average ([\d.]+%), Holt-Winters ([\d.]+%), harmonic regression ([\d.]+%), equal-weight blend ([\d.]+%), ensemble ([\d.]+%)\./,
      'the daily WAPE scorecard',
    )
    expect(largestQueue).toBe(queue)
    const recomputed = ['sma', 'hw', 'dhr', 'equal', 'ensemble'].map((m) => fmtPct(dailyWape(m)))
    expect(recomputed).toEqual(quoted)
  })

  it('quotes the gap by which the harmonic regression edges the ensemble', () => {
    const [points] = readmeMatch(
      /on this data the harmonic regression still edges the ensemble by ([\d.]+) points/,
      'the harmonic regression vs ensemble gap',
    )
    const gap = (dailyWape('ensemble') - dailyWape('dhr')) * 100
    // "Edges" claims the harmonic regression has the lower WAPE.
    expect(gap).toBeGreaterThan(0)
    expect(gap.toFixed(points.split('.')[1]?.length ?? 0)).toBe(points)
  })
})

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }

describe('README capacity example', () => {
  it('states the inputs the illustrative hiring example loads', () => {
    const quoted = readmeMatch(
      /"Load illustrative hiring example" starts with (\d+) heads, (\d+)% shrinkage and (\d+) paid hours: demand rises from (\d+) to (\d+) FTE in week (\d+)\. A (\d+)-person class starts in week (\d+), trains for (\w+) weeks, then ramps over (\w+) weeks\./,
      'the illustrative hiring example inputs',
    )
    const [heads, shrinkage, hours, demandFrom, demandTo, riseWeek, classSize, startWeek] =
      quoted.slice(0, 8).map(Number)
    const [trainingWeeks, rampWeeks] = quoted.slice(8).map((w) => WORD_NUMBERS[w] ?? Number(w))
    const { inputs, demand } = exampleCapacityState()
    expect(Number(inputs.startingHeadcount)).toBe(heads)
    expect(Number(inputs.shrinkagePct)).toBe(shrinkage)
    expect(Number(inputs.paidHoursPerWeek)).toBe(hours)
    expect(demand.map(Number)).toEqual(demand.map((_, i) => (i + 1 < riseWeek ? demandFrom : demandTo)))
    expect(Number(inputs.classSize)).toBe(classSize)
    expect(Number(inputs.startWeek)).toBe(startWeek)
    expect(Number(inputs.trainingWeeks)).toBe(trainingWeeks)
    expect(Number(inputs.rampWeeks)).toBe(rampWeeks)
  })

  it('quotes the baseline shortage week and full proposal coverage', () => {
    const [shortWeek, coveredWeeks] = readmeMatch(
      /The baseline first falls short in week (\d+); the proposal covers all (\d+) weeks\./,
      'the illustrative hiring example outcome',
    )
    const plan = buildCapacityPlan(capacityConfig(exampleCapacityState()))
    expect(String(plan.baseline.firstShortageWeek)).toBe(shortWeek)
    expect(plan.scenario.firstShortageWeek).toBeNull()
    expect(String(plan.weeks.length)).toBe(coveredWeeks)
  })
})
