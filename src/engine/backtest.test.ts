import { beforeAll, describe, expect, it } from 'vitest'
import type { BacktestReport, IntervalRecord } from './types'
import { generateSampleData } from './sampleData'
import { runBacktest, runForecast } from './forecastPipeline'

let records: IntervalRecord[]
let reports: BacktestReport[]

beforeAll(() => {
  records = generateSampleData()
  reports = runBacktest(records, 'voice-benefits')
})

function score(method: string, grain: 'interval' | 'daily' | 'weekly') {
  const report = reports.find((r) => r.scores[0].method === method)!
  return report.scores.find((s) => s.grain === grain)!
}

describe('runBacktest on sample data (voice-benefits, 8 folds)', () => {
  it('runs all folds and scores every method at every grain', () => {
    expect(reports).toHaveLength(4)
    for (const report of reports) {
      expect(report.queue).toBe('voice-benefits')
      expect(report.folds).toBe(8)
      expect(report.horizonDays).toBe(28)
      expect(report.scores.map((s) => s.grain)).toEqual(['interval', 'daily', 'weekly'])
      for (const s of report.scores) {
        expect(Number.isFinite(s.wape)).toBe(true)
        expect(Number.isFinite(s.bias)).toBe(true)
      }
    }
  })

  it('ensemble daily WAPE is at most min(component WAPEs) + 1.5pp', () => {
    const componentWapes = ['sma', 'hw', 'dhr'].map((m) => score(m, 'daily').wape)
    const ensembleWape = score('ensemble', 'daily').wape
    expect(ensembleWape).toBeLessThanOrEqual(Math.min(...componentWapes) + 0.015)
  })

  it('keeps daily bias small for the ensemble', () => {
    expect(Math.abs(score('ensemble', 'daily').bias)).toBeLessThan(0.1)
  })

  it('grains order as expected: weekly <= daily <= interval WAPE for the ensemble', () => {
    // Aggregation cancels noise; a large violation signals a broken grain.
    expect(score('ensemble', 'weekly').wape).toBeLessThanOrEqual(score('ensemble', 'daily').wape + 1e-9)
    expect(score('ensemble', 'daily').wape).toBeLessThanOrEqual(score('ensemble', 'interval').wape + 1e-9)
  })
})

describe('backtest determinism', () => {
  it('returns identical reports on repeated runs', () => {
    const a = runBacktest(records, 'chat-support', { folds: 2 })
    const b = runBacktest(records, 'chat-support', { folds: 2 })
    expect(a).toEqual(b)
  })
})

describe('runForecast on sample data', () => {
  it('returns a complete result with holiday zeros and conserved totals', () => {
    const result = runForecast(records, 'voice-claims')
    expect(result.dailyForecast).toHaveLength(28)
    expect(result.weights.buckets).toHaveLength(3)
    for (const bucket of result.weights.buckets) {
      const sum = bucket.weights.sma + bucket.weights.hw + bucket.weights.dhr
      expect(sum).toBeCloseTo(1, 10)
    }
    expect(result.weights.fallbackEqual).toBe(false)

    // Labor Day 2026-09-07 falls in the horizon (last history day 2026-08-16).
    const laborDay = result.dailyForecast.find((p) => p.date === '2026-09-07')!
    expect(laborDay.total).toBe(0)

    // Intervalized ensemble conserves each daily total.
    const byDate = new Map<string, number>()
    for (const p of result.intervalForecast) {
      const d = p.ts.slice(0, 10)
      byDate.set(d, (byDate.get(d) ?? 0) + p.offered)
    }
    for (const day of result.dailyForecast) {
      expect(byDate.get(day.date)!).toBeCloseTo(day.total, 6)
    }

    // AHT forecast is present and plausible for the voice queue.
    const withVolume = result.intervalForecast.filter((p) => p.offered > 1)
    expect(withVolume.length).toBeGreaterThan(0)
    for (const p of withVolume) {
      expect(p.aht).toBeGreaterThan(300)
      expect(p.aht).toBeLessThan(600)
    }
  })
})

describe('insufficient history (codex review fix)', () => {
  it('returns zero folds and no scores instead of NaN', () => {
    const short = records.filter((r) => r.ts >= '2026-06-01')
    const result = runBacktest(short, 'voice-benefits')
    for (const report of result) {
      expect(report.folds).toBe(0)
      expect(report.scores).toEqual([])
    }
  })
})
