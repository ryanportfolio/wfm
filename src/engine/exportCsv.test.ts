import { describe, expect, it } from 'vitest'
import type { BacktestReport, BandedDailyPoint, ForecastPoint, StaffingInterval } from './types'
import {
  csvNum,
  forecastDailyCsv,
  forecastIntervalCsv,
  scorecardCsv,
  staffingDailyCsv,
  staffingIntervalCsv,
} from './exportCsv'

describe('csvNum', () => {
  it('keeps up to 6 decimals and drops trailing zeros', () => {
    expect(csvNum(0.123456789)).toBe('0.123457')
    expect(csvNum(42)).toBe('42')
    expect(csvNum(1.5)).toBe('1.5')
  })

  it('emits an empty cell for non-finite values', () => {
    expect(csvNum(Number.NaN)).toBe('')
    expect(csvNum(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('forecastDailyCsv', () => {
  const daily: BandedDailyPoint[] = [
    { date: '2026-08-17', total: 1234.5678, aht: 401.25, lo: 1100.1, hi: 1400.9 },
    { date: '2026-08-18', total: 987, aht: 399, lo: 900, hi: 1050 },
  ]

  it('writes header, weekday, and band columns', () => {
    const lines = forecastDailyCsv(daily).trimEnd().split('\n')
    expect(lines[0]).toBe('date,weekday,forecast_offered,lo80,hi80,aht_sec')
    expect(lines).toHaveLength(3)
    // 2026-08-17 is a Monday.
    expect(lines[1]).toBe('2026-08-17,Mon,1234.5678,1100.1,1400.9,401.25')
  })
})

describe('forecastIntervalCsv', () => {
  const points: ForecastPoint[] = [
    { ts: '2026-08-17T08:00:00', offered: 41.2345678, aht: 415 },
    { ts: '2026-08-17T08:30:00', offered: 52, aht: 410 },
    { ts: '2026-08-18T08:00:00', offered: 44, aht: 405 },
  ]

  it('splits ts into date and interval start', () => {
    const lines = forecastIntervalCsv(points).trimEnd().split('\n')
    expect(lines[0]).toBe('date,interval_start,forecast_offered,aht_sec')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('2026-08-17,08:00,41.234568,415')
  })
})

describe('staffingIntervalCsv', () => {
  const intervals: StaffingInterval[] = [
    {
      ts: '2026-08-17T08:00:00',
      queue: 'voice',
      required: 12,
      scheduled: 17.142857,
      occupancy: 0.8123,
      serviceLevel: 0.845,
      asa: 14.2,
      abandonRate: 0.031,
    },
  ]
  const scaled = [{ offered: 45.32, aht: 396.8 }]

  it('pairs scenario-scaled inputs with staffing outputs', () => {
    const lines = staffingIntervalCsv(intervals, scaled).trimEnd().split('\n')
    expect(lines[0]).toBe(
      'date,interval_start,offered,aht_sec,required_agents,scheduled_agents,occupancy,service_level,asa_sec,abandon_rate',
    )
    expect(lines[1]).toBe('2026-08-17,08:00,45.32,396.8,12,17.142857,0.8123,0.845,14.2,0.031')
  })

  it('leaves an empty cell for a non-finite ASA', () => {
    const withNan = [{ ...intervals[0], asa: Number.POSITIVE_INFINITY }]
    const lines = staffingIntervalCsv(withNan, scaled).trimEnd().split('\n')
    expect(lines[1].split(',')[8]).toBe('')
  })
})

describe('staffingDailyCsv', () => {
  it('writes one row per day with weighted metrics as fractions', () => {
    const csv = staffingDailyCsv([
      {
        date: '2026-08-17',
        contacts: 1520.5,
        requiredFte: 88.25,
        scheduledFte: 126.071429,
        peakRequired: 21,
        sl: 0.8412,
        asa: 12.75,
        abandon: 0.0288,
      },
    ])
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe(
      'date,weekday,contacts,required_fte_hours,scheduled_fte_hours,peak_on_phones,service_level,asa_sec,abandon_rate',
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('2026-08-17,Mon,1520.5,88.25,126.071429,21,0.8412,12.75,0.0288')
  })
})

describe('scorecardCsv', () => {
  const report = (method: string, base: number): BacktestReport => ({
    queue: 'voice',
    folds: 8,
    horizonDays: 2,
    scores: (['interval', 'daily', 'weekly'] as const).map((grain, i) => ({
      method,
      grain,
      wape: base + i * 0.01,
      mape: base + 0.1 + i * 0.01,
      bias: -0.005 + i * 0.001,
    })),
    leadDayWape: [base + 0.2, Number.NaN],
  })

  it('writes one row per method with grain and lead-day columns', () => {
    const lines = scorecardCsv([report('sma', 0.2), report('ensemble', 0.1)])
      .trimEnd()
      .split('\n')
    expect(lines[0]).toBe(
      'method,wape_interval,wape_daily,wape_weekly,mape_interval,mape_daily,mape_weekly,' +
        'bias_interval,bias_daily,bias_weekly,wape_lead_day_1,wape_lead_day_2',
    )
    expect(lines).toHaveLength(3)
    const sma = lines[1].split(',')
    expect(sma[0]).toBe('sma')
    expect(sma[1]).toBe('0.2') // wape interval
    expect(sma[2]).toBe('0.21') // wape daily
    expect(sma[10]).toBe('0.4') // lead day 1
    expect(sma[11]).toBe('') // NaN lead day -> empty cell
  })

  it('handles a report with no folds', () => {
    const empty: BacktestReport = { queue: 'voice', folds: 0, horizonDays: 28, scores: [] }
    const lines = scorecardCsv([empty]).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
  })
})
