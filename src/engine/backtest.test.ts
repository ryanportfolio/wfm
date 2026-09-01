import { beforeAll, describe, expect, it } from 'vitest'
import type { BacktestReport, IntervalRecord, RelErrorSample } from './types'
import { generateSampleData } from './sampleData'
import { runBacktest, runForecast } from './forecastPipeline'
import { buildFoldInput } from './backtest'
import { cleanDays } from './clean'
import { groupQueueDays } from './series'
import { forecastEnsemble } from './forecast/ensemble'
import { relError, wape } from './metrics'

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
    expect(reports).toHaveLength(5)
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

  it('ensemble daily WAPE is at most min(component WAPEs) + 0.2pp', () => {
    const componentWapes = ['sma', 'hw', 'dhr'].map((m) => score(m, 'daily').wape)
    const ensembleWape = score('ensemble', 'daily').wape
    expect(ensembleWape).toBeLessThanOrEqual(Math.min(...componentWapes) + 0.002)
  })

  it('fitted ensemble beats the equal-weight benchmark on daily WAPE', () => {
    expect(score('ensemble', 'daily').wape).toBeLessThan(score('equal', 'daily').wape)
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

describe('per-fold and per-lead-day records', () => {
  it('every report carries 28 lead-day WAPEs and 8 fold WAPEs, all finite', () => {
    for (const report of reports) {
      expect(report.leadDayWape).toHaveLength(28)
      expect(report.foldDailyWape).toHaveLength(8)
      for (const v of report.leadDayWape!) expect(Number.isFinite(v)).toBe(true)
      for (const v of report.foldDailyWape!) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('the ensemble report carries relative errors and 80% band quantiles', () => {
    const ens = reports.find((r) => r.scores[0].method === 'ensemble')!
    expect(ens.relErrors!.length).toBeGreaterThan(0)
    expect(ens.relErrors!.length).toBeLessThanOrEqual(8 * 28)
    for (const e of ens.relErrors!) {
      expect(e.lead).toBeGreaterThanOrEqual(1)
      expect(e.lead).toBeLessThanOrEqual(28)
      expect(Number.isFinite(e.rel)).toBe(true)
    }
    expect(ens.bands).toHaveLength(3)
    for (const b of ens.bands!) {
      expect(b.qLo).toBeLessThanOrEqual(0)
      expect(b.qHi).toBeGreaterThanOrEqual(0)
      expect(b.samples).toBeGreaterThanOrEqual(10)
    }
    // Non-ensemble reports carry neither.
    const sma = reports.find((r) => r.scores[0].method === 'sma')!
    expect(sma.relErrors).toBeUndefined()
    expect(sma.bands).toBeUndefined()
  })

  it('aligns lead day 1 with the first forecast day of each fold', () => {
    // Recompute two folds from the engine building blocks and compare.
    const queue = 'chat-support'
    const horizonDays = 28
    const got = runBacktest(records, queue, { folds: 2, horizonDays }).find(
      (r) => r.scores[0].method === 'ensemble',
    )!
    const days = groupQueueDays(records, queue)
    const absErr = new Array<number>(horizonDays).fill(0)
    const absAct = new Array<number>(horizonDays).fill(0)
    const rel: RelErrorSample[] = []
    const foldWapes: number[] = []
    for (let f = 0; f < 2; f++) {
      const originIdx = days.length - horizonDays - f * horizonDays
      const trainDays = days.slice(0, originIdx)
      const testDays = days.slice(originIdx, originIdx + horizonDays)
      const cleaned = cleanDays(trainDays, queue)
      const input = buildFoldInput(
        cleaned.daily,
        cleaned.report.closedHolidays,
        cleaned.report.holidayClosed,
        testDays.map((d) => d.date),
      )
      const { blend } = forecastEnsemble(input, undefined, trainDays.map((d) => d.total))
      for (let j = 0; j < horizonDays; j++) {
        absErr[j] += Math.abs(blend[j] - testDays[j].total)
        absAct[j] += Math.abs(testDays[j].total)
        const r = relError(testDays[j].total, blend[j])
        if (r !== null) rel.push({ lead: j + 1, rel: r })
      }
      foldWapes.push(wape(testDays.map((d) => d.total), blend))
    }
    const expectedLead = absAct.map((a, j) => (a > 0 ? absErr[j] / a : Number.NaN))
    expect(got.leadDayWape).toHaveLength(horizonDays)
    got.leadDayWape!.forEach((v, j) => {
      if (Number.isNaN(expectedLead[j])) expect(Number.isNaN(v)).toBe(true)
      else expect(v).toBeCloseTo(expectedLead[j], 10)
    })
    expect(got.foldDailyWape).toHaveLength(2)
    got.foldDailyWape!.forEach((v, f) => expect(v).toBeCloseTo(foldWapes[f], 10))
    expect(got.relErrors).toEqual(rel)
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

  it('carries an 80% band around every ensemble day', () => {
    const result = runForecast(records, 'voice-claims')
    expect(result.band).not.toBeNull()
    expect(result.band).toHaveLength(3)
    for (const b of result.band!) {
      expect(b.qLo).toBeLessThanOrEqual(0)
      expect(b.qHi).toBeGreaterThanOrEqual(0)
      expect(b.samples).toBeGreaterThanOrEqual(5)
    }
    for (const p of result.ensemble) {
      expect(p.lo).toBeLessThanOrEqual(p.total)
      expect(p.hi).toBeGreaterThanOrEqual(p.total)
      expect(p.lo).toBeGreaterThanOrEqual(0)
    }
    // Some day must have a strictly open band, or the band is decorative.
    expect(result.ensemble.some((p) => p.hi > p.lo)).toBe(true)
    // Closed-holiday zero forecast collapses to a zero band.
    const laborDay = result.ensemble.find((p) => p.date === '2026-09-07')!
    expect(laborDay.lo).toBe(0)
    expect(laborDay.hi).toBe(0)
  })
})

describe('insufficient history', () => {
  it('returns zero folds and no scores instead of NaN', () => {
    const short = records.filter((r) => r.ts >= '2026-06-01')
    const result = runBacktest(short, 'voice-benefits')
    for (const report of result) {
      expect(report.folds).toBe(0)
      expect(report.scores).toEqual([])
    }
  })
})
