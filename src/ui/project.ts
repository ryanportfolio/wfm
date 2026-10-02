import type { IntervalRecord } from '../engine/types'
import { validTimestamp } from '../engine/csv'
import { intervalKey } from '../engine/dataQuality'
import { CAPACITY_LIMITS } from '../engine/capacity'
import { HISTORY_SEED_MAX_WEEKLY_GROWTH } from '../engine/capacitySeed'
import { CAPACITY_SOURCES, capacityConfig, emptyCapacityState, emptyHiringClass, seedGrowth } from './capacityState'
import type { CapacityState } from './capacityState'
import { DEFAULT_SCENARIO } from './controls/ScenarioPanel'
import type { ScenarioState } from './controls/ScenarioPanel'
import { NUM_SPECS, staffingUrlFromHash } from './scenarioUrl'
import type { Horizon } from './ForecastTab'
import type { IntradayState } from './intradayState'
import { intradayNumber, MAX_INTRADAY_CONTACTS, MAX_INTRADAY_HEADS } from '../engine/intraday'
import { addDays, timePart } from '../engine/series'
import { evaluateSchedule, SCHEDULE_LIMITS } from '../engine/schedule'
import type { ScheduleInput, Shift } from '../engine/schedule'
import { MAX_SHRINKAGE_PCT, REQUIREMENT_KEY } from './scheduleState'
import type { ScheduleState } from './scheduleState'

export interface StaffingState {
  a: ScenarioState
  b: ScenarioState | null
  compare: boolean
  costText: string
}
export interface Project {
  schema: 'wfm-project'
  version: 4
  name: string
  records: IntervalRecord[]
  sourceLabel: string
  queue: string
  horizon: Horizon
  staffing: StaffingState
  capacityByQueue: Record<string, CapacityState>
  intradayByQueue: Record<string, IntradayState>
  scheduleByQueue: Record<string, ScheduleState>
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
  fields(s, Object.keys(emptyCapacityState()), label)
  const inputs = object(s.inputs, `${label}.inputs`)
  const defaults = emptyCapacityState()
  fields(inputs, Object.keys(defaults.inputs), `${label}.inputs`)
  // Validate a completed copy so blank drafts survive without masking invalid populated fields.
  for (const key of Object.keys(defaults.inputs) as (keyof CapacityState['inputs'])[]) {
    string(inputs[key], `${label}.${key}`, 100, true)
    if ((inputs[key] as string).trim()) defaults.inputs[key] = inputs[key] as string
  }
  if (!Array.isArray(s.classes) || s.classes.length > CAPACITY_LIMITS.hiringClasses) throw new Error(`${label} needs at most ${CAPACITY_LIMITS.hiringClasses} hiring classes.`)
  defaults.classes = s.classes.map((value: unknown, i: number) => {
    const draft = object(value, `${label}.classes[${i}]`), completed = emptyHiringClass()
    fields(draft, Object.keys(completed), `${label}.classes[${i}]`)
    for (const key of Object.keys(completed) as (keyof typeof completed)[]) {
      string(draft[key], `${label}.classes[${i}].${key}`, 100, true)
      if ((draft[key] as string).trim()) completed[key] = draft[key] as string
    }
    return completed
  })
  if (!Array.isArray(s.demand) || s.demand.length !== 13 || !Array.isArray(s.sources) || s.sources.length !== 13) throw new Error(`${label} needs exactly 13 demand values and sources.`)
  for (let i = 0; i < 13; i++) {
    string(s.demand[i], `${label}.demand[${i}]`, 100, true)
    defaults.demand[i] = s.demand[i].trim() ? s.demand[i] : '0'
    if (!CAPACITY_SOURCES.includes(s.sources[i])) throw new Error(`${label} contains an invalid demand source.`)
  }
  try { capacityConfig(defaults); seedGrowth(defaults) } catch (err) { throw new Error(`${label}: ${(err as Error).message}`) }
  if (s.startDate !== null && (typeof s.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.startDate) || !validTimestamp(`${s.startDate}T00:00`))) throw new Error(`${label}.startDate must be a real ISO date or null.`)
  if (s.seedPaidHours !== null) { number(s.seedPaidHours, `${label}.seedPaidHours`, 0, 168); if (s.seedPaidHours === 0) throw new Error(`${label}.seedPaidHours must be positive.`) }
  const growth = HISTORY_SEED_MAX_WEEKLY_GROWTH * 100
  if (s.seedGrowthPct !== null) number(s.seedGrowthPct, `${label}.seedGrowthPct`, -growth, growth)
  if (!Array.isArray(s.holidayMismatch) || s.holidayMismatch.length !== 13 || s.holidayMismatch.some((v: unknown) => typeof v !== 'boolean')) throw new Error(`${label}.holidayMismatch must hold 13 true/false flags.`)
}
/** Exactly the required keys plus any of the optional ones. */
function someFields(value: Record<string, unknown>, required: string[], optional: string[], label: string) {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) {
    throw new Error(`${label} has missing or unsupported fields.`)
  }
}
/** A queue's 28-day forecast window and interval times, from its history. */
interface QueueHistory { last: string; times: Set<string> }
function forecastDay(h: QueueHistory, d: unknown): d is string {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && validTimestamp(`${d}T00:00`) && d > h.last && d <= addDays(h.last, 28)
}
/**
 * Schedule tab state: drafts are text checked for shape and length only,
 * because clock fields are read against the selected day. A saved schedule
 * must pass the engine's input checks and every shift its template's rules.
 */
function schedule(value: unknown, label: string, h: QueueHistory): asserts value is ScheduleState {
  const s = object(value, label)
  fields(s, ['selectedDay', 'shrinkagePct', 'templates', 'built'], label)
  if (s.selectedDay !== null && !forecastDay(h, s.selectedDay)) throw new Error(`${label} selected day must be in the 28-day forecast window.`)
  string(s.shrinkagePct, `${label} unplanned shrinkage`, 100, true)
  if (s.shrinkagePct.trim()) number(Number(s.shrinkagePct), `${label} unplanned shrinkage`, 0, MAX_SHRINKAGE_PCT)
  if (s.templates !== null) {
    if (!Array.isArray(s.templates) || !s.templates.length || s.templates.length > SCHEDULE_LIMITS.templates) throw new Error(`${label} needs 1 to ${SCHEDULE_LIMITS.templates} shift templates.`)
    const ids = new Set<string>()
    const activity = (value: unknown, where: string, lunch: boolean) => {
      const a = object(value, where)
      fields(a, lunch ? ['minutes', 'earliest', 'latest', 'paid'] : ['minutes', 'earliest', 'latest'], where)
      for (const key of ['minutes', 'earliest', 'latest']) string(a[key], `${where} ${key}`, 100, true)
      if (lunch && typeof a.paid !== 'boolean') throw new Error(`${where} needs a true/false paid setting.`)
    }
    s.templates.forEach((value: unknown, i: number) => {
      const where = `${label} template ${i + 1}`
      const t = object(value, where)
      fields(t, ['id', 'name', 'length', 'earliestStart', 'latestStart', 'stepMinutes', 'breaks', 'lunch', 'minGapMinutes', 'maxShifts'], where)
      string(t.id, `${where} id`, SCHEDULE_LIMITS.idLength)
      if (ids.has(t.id)) throw new Error(`${where} repeats template id "${t.id}".`)
      ids.add(t.id)
      string(t.name, `${where} name`, 300, true)
      for (const key of ['length', 'earliestStart', 'latestStart', 'stepMinutes', 'minGapMinutes', 'maxShifts']) string(t[key], `${where} ${key}`, 100, true)
      if (!Array.isArray(t.breaks) || t.breaks.length > SCHEDULE_LIMITS.breaksPerTemplate) throw new Error(`${where} needs at most ${SCHEDULE_LIMITS.breaksPerTemplate} breaks.`)
      t.breaks.forEach((b: unknown, j: number) => activity(b, `${where} break ${j + 1}`, false))
      if (t.lunch !== null) activity(t.lunch, `${where} lunch`, true)
    })
  }
  if (s.built === null) return
  const where = `${label} built schedule`
  const b = object(s.built, where)
  fields(b, ['requirementKey', 'input', 'shifts', 'greedyCost', 'iterations'], where)
  if (typeof b.requirementKey !== 'string' || !REQUIREMENT_KEY.test(b.requirementKey)) throw new Error(`${where} needs a 14-digit hexadecimal requirement key.`)
  const input = object(b.input, `${where} input`)
  fields(input, ['required', 'intervalMinutes', 'dayStart', 'unplannedShrinkage', 'templates'], `${where} input`)
  if (typeof input.dayStart !== 'string' || input.dayStart[10] !== 'T' || !forecastDay(h, input.dayStart.slice(0, 10)) || !h.times.has(input.dayStart.slice(11))) {
    throw new Error(`${where} must start at an interval of the queue's history on a day in the 28-day forecast window.`)
  }
  if (!Array.isArray(input.required) || input.required.length > h.times.size) throw new Error(`${where} lists more intervals than the queue's day has.`)
  if (!Array.isArray(input.templates) || input.templates.length > SCHEDULE_LIMITS.templates) throw new Error(`${where} needs at most ${SCHEDULE_LIMITS.templates} templates.`)
  input.templates.forEach((value: unknown, i: number) => {
    const w = `${where} template ${i + 1}`
    const t = object(value, w)
    someFields(t, ['id', 'name', 'lengthMinutes', 'start', 'breaks', 'minGapMinutes'], ['lunch', 'maxShifts'], w)
    fields(object(t.start, `${w} start`), ['earliest', 'latest', 'step'], `${w} start`)
    if (!Array.isArray(t.breaks) || t.breaks.length > SCHEDULE_LIMITS.breaksPerTemplate) throw new Error(`${w} needs at most ${SCHEDULE_LIMITS.breaksPerTemplate} breaks.`)
    t.breaks.forEach((r: unknown, j: number) => fields(object(r, `${w} break ${j + 1}`), ['minutes', 'earliestOffset', 'latestOffset'], `${w} break ${j + 1}`))
    if (Object.hasOwn(t, 'lunch')) fields(object(t.lunch, `${w} lunch`), ['minutes', 'earliestOffset', 'latestOffset', 'paid'], `${w} lunch`)
  })
  if (!Array.isArray(b.shifts) || b.shifts.length > SCHEDULE_LIMITS.shifts) throw new Error(`${where} needs at most ${SCHEDULE_LIMITS.shifts} shifts.`)
  b.shifts.forEach((value: unknown, i: number) => fields(object(value, `${where} shift ${i + 1}`), ['templateId', 'startSlot', 'endSlot', 'breakSlots', 'lunchSlot'], `${where} shift ${i + 1}`))
  number(b.greedyCost, `${where} first-pass cost`)
  number(b.iterations, `${where} improvement moves`, 0, SCHEDULE_LIMITS.maxIterations)
  if (!Number.isInteger(b.iterations)) throw new Error(`${where} improvement moves must be a whole number.`)
  try { evaluateSchedule(input as unknown as ScheduleInput, b.shifts as Shift[]) } catch (err) { throw new Error(`${where}: ${(err as Error).message}.`) }
}
/** v2 capacity drafts had one class; v3 makes it a one-element list with no nesting and the same rate for new hires. */
function migrateCapacityV2(value: unknown, label: string): unknown {
  const s = object(value, label)
  fields(s, ['inputs', 'demand', 'sources', 'startDate', 'seedPaidHours'], label)
  const inputs = object(s.inputs, `${label}.inputs`)
  fields(inputs, ['startingHeadcount', 'weeklyAttritionPct', 'paidHoursPerWeek', 'shrinkagePct', 'hourlyCost', 'classSize', 'startWeek', 'trainingWeeks', 'rampWeeks'], `${label}.inputs`)
  const { classSize, startWeek, trainingWeeks, rampWeeks, ...supply } = inputs
  return { inputs: { ...supply, newHireAttritionPct: inputs.weeklyAttritionPct, weeklyGrowthPct: '0' },
    classes: [{ size: classSize, startWeek, trainingWeeks, nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks }],
    demand: s.demand, sources: s.sources, startDate: s.startDate, seedPaidHours: s.seedPaidHours, seedGrowthPct: null, holidayMismatch: Array(13).fill(false) }
}
/** Strict validation runs before serialization and before any imported state is applied. */
export function validateProject(value: unknown): asserts value is Project {
  const p = object(value, 'Project')
  if (p.schema !== 'wfm-project' || p.version !== 4) throw new Error('Unsupported project format or version. Expected WFM project version 4.')
  fields(p, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue', 'intradayByQueue', 'scheduleByQueue'], 'Project')
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
  const history = new Map<string, QueueHistory>()
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
    const validDay = (d: unknown): d is string => forecastDay(h, d)
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
  const schedules = object(p.scheduleByQueue, 'Schedules')
  for (const [queue, value] of Object.entries(schedules)) {
    const h = history.get(queue)
    if (!h) throw new Error(`Schedule queue "${queue}" is absent from the data.`)
    schedule(value, `Schedule (${queue})`, h)
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
  // Only exact legacy shapes migrate, v1 -> v2 -> v3 -> v4. Extra fields must never be silently discarded.
  const version = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined
  if (version === 1) {
    const legacy = object(value, 'Legacy project')
    fields(legacy, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue'], 'Legacy project')
    value = { ...legacy, version: 2, intradayByQueue: {} }
  }
  if (version === 1 || version === 2) {
    const legacy = object(value, 'Legacy project')
    fields(legacy, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue', 'intradayByQueue'], 'Legacy project')
    // fromEntries defines own keys, so a queue named __proto__ stays data.
    const plans = Object.fromEntries(Object.entries(object(legacy.capacityByQueue, 'Capacity plans'))
      .map(([queue, plan]) => [queue, migrateCapacityV2(plan, `Capacity (${queue})`)]))
    value = { ...legacy, version: 3, capacityByQueue: plans }
  }
  if (version === 1 || version === 2 || version === 3) {
    const legacy = object(value, 'Legacy project')
    fields(legacy, ['schema', 'version', 'name', 'records', 'sourceLabel', 'queue', 'horizon', 'staffing', 'capacityByQueue', 'intradayByQueue'], 'Legacy project')
    value = { ...legacy, version: 4, scheduleByQueue: {} }
  }
  validateProject(value)
  return value
}
