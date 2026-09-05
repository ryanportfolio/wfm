import type { ForecastPoint } from './types'
import { buildStaffingGrid, projectAtStaffing } from './staffing'
import type { StaffingConfig } from './staffing'

export interface IntradayInputs {
  /** Number of elapsed intervals, including intervals with zero actual contacts. */
  cutoff: number
  actuals: Record<string, string>
  scheduled: Record<string, string>
}
export interface IntradayRow {
  ts: string
  observed: boolean
  baseline: number
  revised: number
  scheduled: number
  baselineRequired: number
  revisedRequired: number
  baselineSl: number
  revisedSl: number
}
export interface IntradayResult {
  rows: IntradayRow[]
  ratio: number | null
  baselineTotal: number
  revisedTotal: number
  observedActual: number
  observedBaseline: number
}
export const MAX_INTRADAY_CONTACTS = 100_000
export const MAX_INTRADAY_HEADS = 500
export function intradayNumber(text: string, label: string, max: number): number {
  if (!text.trim()) throw new Error(`${label} is missing.`)
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label} must be between 0 and ${max}.`)
  return n
}

/** Observations are used only in the elapsed prefix. No smoothing or backlog carryover. */
export function reforecastDay(points: readonly ForecastPoint[], inputs: IntradayInputs) {
  if (points.length > 48 || !Number.isInteger(inputs.cutoff) || inputs.cutoff < 0 || inputs.cutoff > points.length) throw new Error('Choose a valid elapsed interval count (0 to 48).')
  const seen = new Set<string>()
  points.forEach((p, i) => {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|30)(?::00)?$/.test(p.ts)) throw new Error('Intraday supports half-hour intervals starting at :00 or :30 only. This forecast uses an unsupported interval format.')
    if (seen.has(p.ts) || (i > 0 && p.ts <= points[i - 1].ts) || p.ts.slice(0, 10) !== points[0].ts.slice(0, 10)) throw new Error('Intraday requires one ordered day of unique intervals.')
    seen.add(p.ts)
    if (!Number.isFinite(p.offered) || p.offered < 0 || p.offered > MAX_INTRADAY_CONTACTS) throw new Error('Baseline contacts exceed the intraday limit of 100000 per interval.')
  })
  const actual = points.slice(0, inputs.cutoff).map(p => intradayNumber(inputs.actuals[p.ts] ?? '', `Actual contacts at ${p.ts.slice(11, 16)}`, MAX_INTRADAY_CONTACTS))
  const observedBaseline = points.slice(0, inputs.cutoff).reduce((s, p) => s + p.offered, 0)
  const observedActual = actual.reduce((s, n) => s + n, 0)
  const ratio = observedBaseline > 0 ? observedActual / observedBaseline : null
  const revised = points.map((p, i) => i < inputs.cutoff ? actual[i] : p.offered * (ratio ?? 1))
  if (revised.some(n => !Number.isFinite(n) || n > MAX_INTRADAY_CONTACTS)) throw new Error('Revised contacts exceed the intraday limit of 100000 per interval.')
  return { ratio, revised, observedActual, observedBaseline, baselineTotal: points.reduce((s, p) => s + p.offered, 0), revisedTotal: revised.reduce((s, n) => s + n, 0) }
}

/** Bounded worker job. Uses existing staffing math for both sides with identical assumptions. */
export function calculateIntraday(points: readonly ForecastPoint[], inputs: IntradayInputs, config: StaffingConfig): IntradayResult {
  const forecast = reforecastDay(points, inputs)
  const concurrency = config.chatConcurrency ?? 1
  if (config.intervalSec !== 1800 || !Number.isFinite(concurrency) || concurrency < 1 || concurrency > 10
    || !Number.isFinite(config.shrinkage) || config.shrinkage < 0 || config.shrinkage > .8
    || !['erlangA', 'erlangC'].includes(config.mode)
    || !(config.slPct >= .5 && config.slPct <= .99) || !(config.slSeconds >= 1 && config.slSeconds <= 300)
    || !(config.patienceSec >= 10 && config.patienceSec <= 600)
    || (config.occupancyCap !== undefined && !(config.occupancyCap >= .5 && config.occupancyCap <= 1))
    || (config.maxAbandonPct !== undefined && !(config.maxAbandonPct >= .01 && config.maxAbandonPct <= 1))) throw new Error('Intraday staffing assumptions are outside supported limits. Adjust scenario A in Staffing.')
  const scheduled = points.map(p => intradayNumber(inputs.scheduled[p.ts] ?? '0', `Scheduled heads at ${p.ts.slice(11, 16)}`, MAX_INTRADAY_HEADS))
  // Erlang A repeatedly constructs a stationary distribution. Bound offered load before any solve.
  points.forEach((p, i) => {
    if (!Number.isFinite(p.aht) || p.aht < 0 || p.aht > 7200 || (Math.max(p.offered, forecast.revised[i]) > 0 && p.aht === 0)) throw new Error('Positive demand needs AHT between 0 and 7200 seconds (exclusive of zero).')
    if (Math.max(p.offered, forecast.revised[i]) * p.aht / concurrency / 1800 > 100) throw new Error('Intraday supports up to 100 Erlangs per interval. Check contact counts, AHT units and concurrency. Larger queues exceed this intraday model’s supported workload.')
  })
  const boundedConfig = { ...config, fixedScheduled: undefined }
  const baseline = buildStaffingGrid(points, undefined, boundedConfig)
  const revised = buildStaffingGrid(points.map((p, i) => ({ ...p, offered: forecast.revised[i] })), undefined, boundedConfig)
  const rows = points.map((p, i) => {
    const bodies = scheduled[i] * (1 - config.shrinkage)
    const project = (volume: number) => projectAtStaffing(config.mode, volume, p.aht / concurrency, 1800, config.slSeconds, bodies, config.patienceSec).sl
    return { ts: p.ts, observed: i < inputs.cutoff, baseline: p.offered, revised: forecast.revised[i], scheduled: scheduled[i], baselineRequired: baseline.intervals[i].required, revisedRequired: revised.intervals[i].required, baselineSl: project(p.offered), revisedSl: project(forecast.revised[i]) }
  })
  return { ...forecast, rows }
}

/** CSV preserves entered scheduled heads; displayed contacts and SL use table precision. */
export function intradayCsv(result: IntradayResult): string {
  return ['interval,status,baseline_contacts,revised_contacts,scheduled_heads,baseline_required_bodies,revised_required_bodies,baseline_sl_pct,revised_sl_pct', ...result.rows.map(r => [r.ts, r.observed ? 'observed' : 'remaining', r.baseline.toFixed(1), r.revised.toFixed(1), r.scheduled, r.baselineRequired, r.revisedRequired, (r.baselineSl * 100).toFixed(1), (r.revisedSl * 100).toFixed(1)].join(','))].join('\n')
}
