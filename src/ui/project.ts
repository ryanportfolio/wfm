import type { IntervalRecord } from '../engine/types'
import { validTimestamp } from '../engine/csv'
import { intervalKey } from '../engine/dataQuality'
import { capacityConfig, emptyCapacityState } from './capacityState'
import type { CapacityState } from './capacityState'
import { DEFAULT_SCENARIO } from './controls/ScenarioPanel'
import type { ScenarioState } from './controls/ScenarioPanel'
import { NUM_SPECS, staffingUrlFromHash } from './scenarioUrl'
import type { Horizon } from './ForecastTab'
import type { IntradayState } from './intradayState'
import { intradayNumber, MAX_INTRADAY_CONTACTS, MAX_INTRADAY_HEADS } from '../engine/intraday'
import { addDays, timePart } from '../engine/series'

export interface StaffingState {
  a: ScenarioState
  b: ScenarioState | null
  compare: boolean
  costText: string
}
export interface Project {
  schema: 'wfm-project'
  version: 2
  name: string
  records: IntervalRecord[]
  sourceLabel: string
  queue: string
  horizon: Horizon
  staffing: StaffingState
  capacityByQueue: Record<string, CapacityState>
  intradayByQueue: Record<string, IntradayState>
}
// The bundled 105120-row sample is about 10 MB. Leave room for larger histories.
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024
export const MAX_PROJECT_ROWS = 500_000

export function initialStaffing(hash: string): StaffingState {
  const url = staffingUrlFromHash(hash)
  return { a: url.scenarios?.a ?? { ...DEFAULT_SCENARIO }, b: url.scenarios?.b ?? null,
    compare: url.scenarios?.b != null, costText: url.costPerHour === null ? '' : String(url.costPerHour) }
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) {
    throw new Error(`${label} has missing or unsupported fields.`)
  }
}
function string(value: unknown, label: string, max = 300, blank = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!blank && !value.trim())) throw new Error(`${label} must be ${blank ? '' : 'nonempty '}text, at most ${max} characters.`)
}
function number(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number between ${min} and ${max}.`)
}
function scenario(value: unknown, label: string): asserts value is ScenarioState {
  const s = object(value, label)
  fields(s, Object.keys(DEFAULT_SCENARIO), label)
  if (!['erlangA', 'erlangC'].includes(s.mode as string) || !['fixed', 'target'].includes(s.staffMode as string)
    || typeof s.useAbandonCap !== 'boolean') throw new Error(`${label} contains invalid mode or boolean settings.`)
  for (const spec of NUM_SPECS) number(s[spec.field], `${label}.${spec.field}`, spec.min, spec.max)
}
function capacity(value: unknown, label: string): asserts value is CapacityState {
  const s = object(value, label)
  fields(s, ['inputs', 'demand', 'sources', 'startDate', 'seedPaidHours'], label)
  const inputs = object(s.inputs, `${label}.inputs`)
  const defaults = emptyCapacityState()
  fields(inputs, Object.keys(defaults.inputs), `${label}.inputs`)
  // Validate a completed copy so blank drafts survive without masking invalid populated fields.
  for (const key of Object.keys(defaults.inputs) as (keyof CapacityState['inputs'])[]) {
    string(inputs[key], `${label}.${key}`, 100, true)
    if ((inputs[key] as string).trim()) defaults.inputs[key] = inputs[key] as string
  }
  if (!Array.isArray(s.demand) || s.demand.length !== 13 || !Array.isArray(s.sources) || s.sources.length !== 13) throw new Error(`${label} needs exactly 13 demand values and sources.`)
  for (let i = 0; i < 13; i++) {
    string(s.demand[i], `${label}.demand[${i}]`, 100, true)
    defaults.demand[i] = s.demand[i].trim() ? s.demand[i] : '0'
    if (!['unset', 'manual', 'example', 'forecast', 'assumption'].includes(s.sources[i])) throw new Error(`${label} contains an invalid demand source.`)
  }
  try { capacityConfig(defaults) } catch (err) { throw new Error(`${label}: ${(err as Error).message}`) }
  if (s.startDate !== null && (typeof s.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.startDate) || !validTimestamp(`${s.startDate}T00:00`))) throw new Error(`${label}.startDate must be a real ISO date or null.`)
  if (s.seedPaidHours !== null) { number(s.seedPaidHours, `${label}.seedPaidHours`, 0, 168); if (s.seedPaidHours === 0) throw new Error(`${label}.seedPaidHours must be positive.`) }
}
/** Strict validation runs before serialization and before any imported state is applied. */
export function validateProject(value: unknown): asserts value is Project {
  const p = object(value, 'Project')
  if (p.schema !== 'wfm-project' || p.version !== 2) throw new Error('Unsupported project format or version. Expected WFM project version 2.')
  fields(p, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue', 'intradayByQueue'], 'Project')
  string(p.name, 'Project name', 120)
  string(p.sourceLabel, 'Data source', 1000)
  if (!Array.isArray(p.records) || !p.records.length || p.records.length > MAX_PROJECT_ROWS) throw new Error(`Project needs 1 to ${MAX_PROJECT_ROWS} interval rows.`)
  const queues = new Set<string>(), keys = new Set<string>()
  for (let i = 0; i < p.records.length; i++) {
    const r = object(p.records[i], `Row ${i + 1}`)
    fields(r, ['ts', 'queue', 'offered', 'aht'], `Row ${i + 1}`)
    string(r.ts, `Row ${i + 1} timestamp`)
    if (!validTimestamp(r.ts)) throw new Error(`Row ${i + 1} has an invalid timestamp.`)
    string(r.queue, `Row ${i + 1} queue`)
    if (r.queue !== r.queue.trim()) throw new Error(`Row ${i + 1} queue has leading or trailing spaces.`)
    number(r.offered, `Row ${i + 1} offered`)
    number(r.aht, `Row ${i + 1} AHT`)
    if (r.offered > 0 && r.aht === 0) throw new Error(`Row ${i + 1} AHT must be positive when contacts are offered.`)
    const key = intervalKey({ queue: r.queue, ts: r.ts })
    if (keys.has(key)) throw new Error(`Row ${i + 1} duplicates a queue/timestamp.`)
    keys.add(key); queues.add(r.queue)
  }
  if (typeof p.queue !== 'string' || !queues.has(p.queue)) throw new Error('Selected queue must exist in the project data.')
  if (![7, 14, 28].includes(p.horizon as number)) throw new Error('Forecast horizon must be 7, 14, or 28 days.')
  const s = object(p.staffing, 'Staffing')
  fields(s, ['a', 'b', 'compare', 'costText'], 'Staffing')
  scenario(s.a, 'Scenario A')
  if (s.b !== null) scenario(s.b, 'Scenario B')
  if (typeof s.compare !== 'boolean' || (s.compare && s.b === null)) throw new Error('Comparison needs a boolean setting and scenario B when enabled.')
  string(s.costText, 'Staffing hourly cost', 100, true)
  if (s.costText.trim()) number(Number(s.costText), 'Staffing hourly cost', 0, 1_000_000)
  const plans = object(p.capacityByQueue, 'Capacity plans')
  for (const [key, plan] of Object.entries(plans)) {
    if (!queues.has(key)) throw new Error(`Capacity queue "${key}" is absent from the data.`)
    capacity(plan, `Capacity (${key})`)
  }
  const intraday = object(p.intradayByQueue, 'Intraday plans')
  // Forecast dates are the 28 days after the last date in each queue; times come from its history.
  // Retain days outside the selected shorter horizon, allowing an exact restore when expanded.
  const history = new Map<string, { last: string; times: Set<string> }>()
  for (const r of p.records as IntervalRecord[]) {
    const h = history.get(r.queue) ?? { last: '', times: new Set<string>() }
    if (r.ts.slice(0, 10) > h.last) h.last = r.ts.slice(0, 10)
    h.times.add(timePart(r.ts)); history.set(r.queue, h)
  }
  for (const [queue, value] of Object.entries(intraday)) {
    const h = history.get(queue)
    if (!h) throw new Error(`Intraday queue "${queue}" is absent from the data.`)
    const state = object(value, 'Intraday state')
    fields(state, ['selectedDay', 'days'], 'Intraday state')
    const validDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && validTimestamp(`${d}T00:00`) && d > h.last && d <= addDays(h.last, 28)
    if (state.selectedDay !== null && !validDay(state.selectedDay)) throw new Error('Intraday selected day must be in the 28-day forecast window.')
    const days = object(state.days, 'Intraday days')
    if (Object.keys(days).length > 28) throw new Error('Intraday has more than 28 days.')
    for (const [date, value] of Object.entries(days)) {
      if (!validDay(date)) throw new Error('Intraday day must be in the 28-day forecast window.')
      const day = object(value, 'Intraday day')
      fields(day, ['cutoff', 'actuals', 'scheduled'], 'Intraday day')
      number(day.cutoff, 'Intraday cutoff', 0, Math.min(48, h.times.size))
      if (!Number.isInteger(day.cutoff)) throw new Error('Intraday cutoff must be a whole interval count.')
      const observedTimes = new Set([...h.times].sort().slice(0, day.cutoff))
      for (const field of ['actuals', 'scheduled'] as const) {
        const entries = object(day[field], `Intraday ${field}`)
        if (Object.keys(entries).length > 48) throw new Error('Intraday supports at most 48 interval inputs.')
        for (const [ts, text] of Object.entries(entries)) {
          if (!ts.startsWith(date + 'T') || !h.times.has(ts.slice(11))) throw new Error('Intraday interval key is absent from the forecast profile.')
          string(text, `Intraday ${field}`, 100, true)
          // Future actuals are inactive drafts, hidden and ignored by the engine.
          // Retain their text; validate the number when the cutoff includes it.
          if (text.trim() && (field === 'scheduled' || observedTimes.has(ts.slice(11)))) intradayNumber(text, `Intraday ${field}`, field === 'actuals' ? MAX_INTRADAY_CONTACTS : MAX_INTRADAY_HEADS)
        }
      }
    }
  }
}
export function serializeProject(project: Project): string {
  validateProject(project)
  const text = JSON.stringify(project)
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 64 MB file limit.')
  return text
}
export function parseProject(text: string): Project {
  if (text.length > MAX_PROJECT_BYTES || new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) throw new Error('Project exceeds the 64 MB file limit.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Could not read project JSON. Choose a saved WFM project file.') }
  // Only the exact legacy root migrates. Extra fields must never be silently discarded.
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 1) {
    const legacy = object(value, 'Legacy project')
    fields(legacy, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue'], 'Legacy project')
    value = { ...legacy, version: 2, intradayByQueue: {} }
  }
  validateProject(value)
  return value
}
