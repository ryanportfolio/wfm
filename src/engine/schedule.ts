/**
 * Single-queue, single-day shift schedule builder.
 *
 * Input: per-interval on-phone requirement (StaffingInterval.required from
 * the Erlang grid), shift templates, and unplanned shrinkage. Output: shifts
 * with explicit break and lunch slots, per-interval coverage, and cost totals.
 *
 * Model:
 * - Internal resolution is 15-minute slots. A scheduled agent counts as 1 in
 *   every slot of the shift except its break and lunch slots. A 30-minute
 *   interval's coverage is the mean of its two slots, so a 15-minute break
 *   removes half an agent from that interval.
 * - Target per interval = required / (1 - unplannedShrinkage). Breaks and
 *   lunch are placed explicitly, so unplannedShrinkage must exclude them; it
 *   covers absence, coaching, meetings and other time the templates do not
 *   schedule.
 * - Shifts start and end inside the planning day. Nothing runs overnight or
 *   carries into another day.
 * - Times are wall-clock: interval i starts i x intervalMinutes after
 *   dayStart, with no daylight-saving adjustment. A day containing a clock
 *   change is treated as if every interval had its nominal length.
 * - Cost, in agent-slots (one agent for 15 minutes): UNDER_WEIGHT x
 *   under-coverage + OVER_WEIGHT x over-coverage + PAID_WEIGHT x paid slots.
 *   Under and over are measured per interval against its target.
 *
 * Algorithm: greedy construction, then local search that accepts strict cost
 * improvements only, with move order from a seeded PRNG. It is a heuristic
 * and does not prove optimality.
 *
 * Not modeled: named agents, days off, weekly hours, agent preferences,
 * skills or multiple queues, and labor-law rules. Requirements come from
 * per-interval Erlang steady-state solves, so backlog carried between
 * intervals is invisible to the builder.
 */

/** Cost per agent-slot of under-coverage. */
export const UNDER_WEIGHT = 10
/** Cost per agent-slot of over-coverage. */
export const OVER_WEIGHT = 1
/** Cost per paid agent-slot; breaks are paid, an unpaid lunch is not. */
export const PAID_WEIGHT = 0.01
export const DEFAULT_UNPLANNED_SHRINKAGE = 0.15
export const DEFAULT_MAX_ITERATIONS = 20_000
export const SLOT_MINUTES = 15

export const SCHEDULE_LIMITS = {
  templates: 12,
  breaksPerTemplate: 4,
  /** Total shifts in one schedule. */
  shifts: 500,
  /** On-phone agents required in one interval. */
  requiredPerInterval: 500,
  dayMinutes: 1440,
  unplannedShrinkage: 0.8,
  maxIterations: 1_000_000,
  idLength: 64,
  nameLength: 100,
} as const

/** Times are minutes, offsets measured from shift start. All multiples of 15. */
export interface ActivityRule {
  minutes: number
  /** Earliest allowed activity start, minutes after shift start. */
  earliestOffset: number
  /** Latest allowed activity start, minutes after shift start. */
  latestOffset: number
}

export interface LunchRule extends ActivityRule {
  /** Paid lunch counts toward paid minutes; unpaid lunch does not. */
  paid: boolean
}

export interface ShiftTemplate {
  id: string
  name: string
  /** Time on site from shift start to shift end, including breaks and lunch. */
  lengthMinutes: number
  /** Allowed shift starts, minutes after day start: earliest, earliest + step, ... <= latest. */
  start: { earliest: number; latest: number; step: number }
  /** Paid breaks, kept in this order within the shift. */
  breaks: readonly ActivityRule[]
  lunch?: LunchRule
  /** Minimum minutes between consecutive activities and between shift start/end and any activity. */
  minGapMinutes: number
  /** Optional cap on shifts built from this template. */
  maxShifts?: number
}

export interface ScheduleInput {
  /** On-phone agents required per interval, e.g. StaffingInterval.required. */
  required: readonly number[]
  intervalMinutes: 15 | 30
  /** First interval start, ISO local "YYYY-MM-DDTHH:MM" with optional ":00" seconds, on a 15-minute boundary. */
  dayStart: string
  /** Fraction 0 to 0.8, default 0.15. Must exclude breaks and lunch, which are scheduled explicitly. */
  unplannedShrinkage?: number
  templates: readonly ShiftTemplate[]
}

export interface ScheduleOptions {
  /** PRNG seed for local-search move order, unsigned 32-bit integer. Default 1. */
  seed?: number
  /** Local-search move attempts. Default DEFAULT_MAX_ITERATIONS; 0 returns the greedy schedule. */
  maxIterations?: number
  /** Wall-clock budget for the whole build, milliseconds, measured with `now`. */
  deadlineMs?: number
  /** Clock in milliseconds; default performance.now. Injectable for tests. */
  now?: () => number
}

export interface Shift {
  templateId: string
  /** First 15-minute slot of the shift, counted from day start. */
  startSlot: number
  /** Slot after the last slot of the shift. */
  endSlot: number
  /** Start slot of each break, in template order. */
  breakSlots: number[]
  /** Start slot of lunch, or null when the template has none. */
  lunchSlot: number | null
}

export interface ScheduleRow {
  ts: string
  required: number
  /** required / (1 - unplannedShrinkage) */
  target: number
  /** Mean on-phone agents over the interval's slots. */
  scheduled: number
  over: number
  under: number
}

export interface ScheduleTotals {
  shiftCount: number
  paidAgentHours: number
  underAgentHours: number
  overAgentHours: number
}

export interface ScheduleResult {
  shifts: Shift[]
  rows: ScheduleRow[]
  totals: ScheduleTotals
  greedyCost: number
  finalCost: number
  /** Local-search move attempts made. */
  iterations: number
}

/** Small seeded PRNG (mulberry32): uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Paid minutes: shift length minus an unpaid lunch. Breaks are paid. */
export function paidMinutes(template: ShiftTemplate): number {
  return template.lengthMinutes - (template.lunch && !template.lunch.paid ? template.lunch.minutes : 0)
}

/**
 * Clock time "HH:MM" of a 15-minute slot, counted from midnight of the
 * dayStart date (wall clock, no daylight-saving adjustment). A slot at the
 * next midnight reads "24:00"; later slots keep counting, so "25:30" is
 * 01:30 the next day.
 */
export function slotClock(dayStart: string, slot: number): string {
  const minutes = Number(dayStart.slice(11, 13)) * 60 + Number(dayStart.slice(14, 16)) + slot * SLOT_MINUTES
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** Activity order inside one shift with earliest and latest feasible offsets per position. */
interface Variant {
  seq: number[]
  earliest: number[]
  latest: number[]
}

/** Template in slot units. Activity index: breaks first, then lunch. */
interface Prepared {
  len: number
  starts: number[]
  dur: number[]
  lo: number[]
  hi: number[]
  gap: number
  nBreaks: number
  paidSlots: number
  cap: number
  variants: Variant[]
}

interface WorkShift {
  t: number
  si: number
  start: number
  offs: number[]
}

const EPS = 1e-9

function minutesField(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max || value % SLOT_MINUTES !== 0) {
    throw new RangeError(`${field} must be a multiple of 15 minutes between ${min} and ${max}`)
  }
  return value / SLOT_MINUTES
}

function integerField(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Earliest/latest feasible offsets for an activity order, or null when the order cannot fit. */
function variantBounds(seq: number[], p: Pick<Prepared, 'len' | 'dur' | 'lo' | 'hi' | 'gap'>): Variant | null {
  const n = seq.length
  const earliest: number[] = []
  const latest: number[] = new Array(n)
  let next = p.gap
  for (const a of seq) {
    const e = Math.max(p.lo[a], next)
    earliest.push(e)
    next = e + p.dur[a] + p.gap
  }
  let limit = p.len - p.gap
  for (let j = n - 1; j >= 0; j--) {
    const a = seq[j]
    latest[j] = Math.min(p.hi[a], limit - p.dur[a])
    limit = latest[j] - p.gap
  }
  for (let j = 0; j < n; j++) if (earliest[j] > latest[j]) return null
  return { seq, earliest, latest }
}

function prepareTemplate(t: ShiftTemplate, index: number, daySlots: number): Prepared {
  const where = `templates[${index}]`
  if (typeof t !== 'object' || t === null) throw new TypeError(`${where} must be an object`)
  const label = `Template "${String(t.id)}"`
  const dayMinutes = daySlots * SLOT_MINUTES
  const len = minutesField(t.lengthMinutes, `${label} lengthMinutes`, SLOT_MINUTES, dayMinutes)
  if (typeof t.start !== 'object' || t.start === null) throw new TypeError(`${label} start must be an object`)
  const earliest = minutesField(t.start.earliest, `${label} start.earliest`, 0, dayMinutes)
  const latest = minutesField(t.start.latest, `${label} start.latest`, 0, dayMinutes)
  const step = minutesField(t.start.step, `${label} start.step`, SLOT_MINUTES, dayMinutes)
  if (latest < earliest) throw new RangeError(`${label} start.latest must not be before start.earliest`)
  if (latest + len > daySlots) {
    throw new RangeError(`${label} latest start plus ${t.lengthMinutes}-minute length ends after the ${dayMinutes}-minute day; shifts cannot run past day end`)
  }
  const starts: number[] = []
  for (let s = earliest; s <= latest; s += step) starts.push(s)
  const gap = minutesField(t.minGapMinutes, `${label} minGapMinutes`, 0, t.lengthMinutes)
  if (!Array.isArray(t.breaks) || t.breaks.length > SCHEDULE_LIMITS.breaksPerTemplate) {
    throw new RangeError(`${label} breaks must be a list of at most ${SCHEDULE_LIMITS.breaksPerTemplate}`)
  }
  const rules: ActivityRule[] = [...t.breaks]
  if (t.lunch !== undefined) {
    if (typeof t.lunch !== 'object' || t.lunch === null || typeof t.lunch.paid !== 'boolean') {
      throw new RangeError(`${label} lunch must have a boolean paid flag`)
    }
    rules.push(t.lunch)
  }
  const dur: number[] = []
  const lo: number[] = []
  const hi: number[] = []
  rules.forEach((r, i) => {
    const what = i < t.breaks.length ? `${label} breaks[${i}]` : `${label} lunch`
    if (typeof r !== 'object' || r === null) throw new TypeError(`${what} must be an object`)
    dur.push(minutesField(r.minutes, `${what}.minutes`, SLOT_MINUTES, t.lengthMinutes))
    lo.push(minutesField(r.earliestOffset, `${what}.earliestOffset`, 0, t.lengthMinutes))
    hi.push(minutesField(r.latestOffset, `${what}.latestOffset`, 0, t.lengthMinutes))
    if (hi[i] < lo[i]) throw new RangeError(`${what}.latestOffset must not be before earliestOffset`)
    if (hi[i] + dur[i] > len) throw new RangeError(`${what} latestOffset plus minutes runs past shift end`)
  })
  const nBreaks = t.breaks.length
  const cap = t.maxShifts === undefined ? SCHEDULE_LIMITS.shifts : integerField(t.maxShifts, `${label} maxShifts`, 0, SCHEDULE_LIMITS.shifts)
  const base = { len, dur, lo, hi, gap }
  const breakOrder = Array.from({ length: nBreaks }, (_, i) => i)
  const orders = t.lunch === undefined ? [breakOrder]
    : Array.from({ length: nBreaks + 1 }, (_, pos) => [...breakOrder.slice(0, pos), nBreaks, ...breakOrder.slice(pos)])
  const variants = orders.map(seq => variantBounds(seq, base)).filter((v): v is Variant => v !== null)
  if (variants.length === 0) {
    throw new RangeError(`${label} cannot be satisfied: breaks and lunch do not fit their windows, order and the ${t.minGapMinutes}-minute minimum gap within the ${t.lengthMinutes}-minute shift`)
  }
  const paidSlots = minutesField(paidMinutes(t), `${label} paid minutes`, 0, t.lengthMinutes)
  return { len, starts, dur, lo, hi, gap, nBreaks, paidSlots, cap, variants }
}

/** Parses dayStart into a UTC-epoch stand-in for local wall time. */
function parseDayStart(dayStart: unknown): number {
  const m = typeof dayStart === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(dayStart) : null
  if (!m || Number(m[5]) % SLOT_MINUTES !== 0) {
    throw new RangeError('dayStart must be an ISO local time "YYYY-MM-DDTHH:MM" on a 15-minute boundary')
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]))
  const check = new Date(ms)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError('dayStart is not a valid calendar date')
  }
  return ms
}

function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

interface Context {
  prepared: Prepared[]
  k: number
  dayMs: number
  shrinkage: number
  seed: number
  maxIterations: number
  deadlineMs: number | undefined
  now: () => number
}

function validate(input: ScheduleInput, options: ScheduleOptions): Context {
  if (typeof input !== 'object' || input === null) throw new TypeError('Schedule input must be an object')
  if (input.intervalMinutes !== 15 && input.intervalMinutes !== 30) throw new RangeError('intervalMinutes must be 15 or 30')
  const k = input.intervalMinutes / SLOT_MINUTES
  const maxIntervals = SCHEDULE_LIMITS.dayMinutes / input.intervalMinutes
  if (!Array.isArray(input.required) || input.required.length < 1 || input.required.length > maxIntervals) {
    throw new RangeError(`required must list 1 to ${maxIntervals} intervals (a day of at most 24 hours)`)
  }
  for (let i = 0; i < input.required.length; i++) {
    const r = input.required[i]
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > SCHEDULE_LIMITS.requiredPerInterval) {
      throw new RangeError(`required[${i}] must be a finite number between 0 and ${SCHEDULE_LIMITS.requiredPerInterval}`)
    }
  }
  const dayMs = parseDayStart(input.dayStart)
  const shrinkage = input.unplannedShrinkage ?? DEFAULT_UNPLANNED_SHRINKAGE
  if (typeof shrinkage !== 'number' || !(shrinkage >= 0 && shrinkage <= SCHEDULE_LIMITS.unplannedShrinkage)) {
    throw new RangeError(`unplannedShrinkage must be between 0 and ${SCHEDULE_LIMITS.unplannedShrinkage}`)
  }
  if (!Array.isArray(input.templates) || input.templates.length < 1 || input.templates.length > SCHEDULE_LIMITS.templates) {
    throw new RangeError(`templates must list 1 to ${SCHEDULE_LIMITS.templates} shift templates`)
  }
  const ids = new Set<string>()
  input.templates.forEach((t, i) => {
    if (typeof t?.id !== 'string' || !t.id.trim() || t.id.length > SCHEDULE_LIMITS.idLength) {
      throw new RangeError(`templates[${i}].id must be a non-empty string of at most ${SCHEDULE_LIMITS.idLength} characters`)
    }
    if (ids.has(t.id)) throw new RangeError(`Template id "${t.id}" is used more than once`)
    ids.add(t.id)
    if (typeof t.name !== 'string' || t.name.length > SCHEDULE_LIMITS.nameLength) {
      throw new RangeError(`Template "${t.id}" name must be a string of at most ${SCHEDULE_LIMITS.nameLength} characters`)
    }
  })
  const daySlots = input.required.length * k
  const prepared = input.templates.map((t, i) => prepareTemplate(t, i, daySlots))
  const seed = options.seed === undefined ? 1 : integerField(options.seed, 'seed', 0, 0xffffffff)
  const maxIterations = options.maxIterations === undefined ? DEFAULT_MAX_ITERATIONS
    : integerField(options.maxIterations, 'maxIterations', 0, SCHEDULE_LIMITS.maxIterations)
  const deadlineMs = options.deadlineMs
  if (deadlineMs !== undefined && !(typeof deadlineMs === 'number' && deadlineMs > 0 && Number.isFinite(deadlineMs))) {
    throw new RangeError('deadlineMs must be a positive finite number of milliseconds')
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function')
  return { prepared, k, dayMs, shrinkage, seed, maxIterations, deadlineMs, now: options.now ?? (() => performance.now()) }
}

/** Shift rules against the template, in slot offsets from shift start. */
function offsetsValid(p: Prepared, offs: readonly number[]): boolean {
  for (let a = 0; a < offs.length; a++) if (offs[a] < p.lo[a] || offs[a] > p.hi[a]) return false
  for (let b = 1; b < p.nBreaks; b++) if (offs[b] <= offs[b - 1]) return false
  const order = offs.map((_, a) => a).sort((x, y) => offs[x] - offs[y])
  let next = p.gap
  for (const a of order) {
    if (offs[a] < next) return false
    next = offs[a] + p.dur[a] + p.gap
  }
  return next <= p.len
}

/** Cost of one interval at `c` covered agent-slots against `goal` agent-slots. */
function intervalCostAt(goal: number, c: number): number {
  const d = goal - c
  return d > 0 ? UNDER_WEIGHT * d : -OVER_WEIGHT * d
}

/** Target per interval in agent-slots: k x required / (1 - shrinkage). */
function goalSlots(input: ScheduleInput, ctx: Context): Float64Array {
  const goal = new Float64Array(input.required.length)
  for (let i = 0; i < goal.length; i++) goal[i] = ctx.k * input.required[i] / (1 - ctx.shrinkage)
  return goal
}

/** Coverage cost summed over intervals in order, plus paid cost. */
function scheduleCost(goal: Float64Array, sums: Int32Array, paidSlots: number): number {
  let cost = 0
  for (let i = 0; i < goal.length; i++) cost += intervalCostAt(goal[i], sums[i])
  return cost + PAID_WEIGHT * paidSlots
}

/** Per-interval rows and under/over agent-hours from agent-slot sums per interval. */
function coverage(input: ScheduleInput, ctx: Context, sums: Int32Array): { rows: ScheduleRow[]; under: number; over: number } {
  const hours = input.intervalMinutes / 60
  let under = 0
  let over = 0
  const rows: ScheduleRow[] = input.required.map((required, i) => {
    const target = required / (1 - ctx.shrinkage)
    const scheduled = sums[i] / ctx.k
    const row = {
      ts: formatTs(ctx.dayMs + i * input.intervalMinutes * 60_000),
      required, target, scheduled,
      over: Math.max(0, scheduled - target),
      under: Math.max(0, target - scheduled),
    }
    under += row.under * hours
    over += row.over * hours
    return row
  })
  return { rows, under, over }
}

/**
 * Coverage rows, totals and final cost of given shifts, such as a schedule
 * restored from a file. Runs buildSchedule's input checks, then checks every
 * shift against its template: a known template id, a start from the
 * template's start list, the template's length, one start per break in
 * order, a lunch exactly when the template has one, activity windows and
 * minimum gaps, and the shift caps. Throws RangeError or TypeError.
 */
export function evaluateSchedule(input: ScheduleInput, shifts: readonly Shift[]): Pick<ScheduleResult, 'rows' | 'totals' | 'finalCost'> {
  const ctx = validate(input, {})
  const { prepared, k } = ctx
  if (!Array.isArray(shifts) || shifts.length > SCHEDULE_LIMITS.shifts) throw new RangeError(`shifts must be a list of at most ${SCHEDULE_LIMITS.shifts}`)
  const index = new Map(input.templates.map((t, i) => [t.id, i]))
  const counts = prepared.map(() => 0)
  const sums = new Int32Array(input.required.length)
  const add = (from: number, to: number, sign: number) => {
    for (let s = from; s < to; s++) sums[k === 1 ? s : s >> 1] += sign
  }
  let paidSlots = 0
  shifts.forEach((sh, i) => {
    const where = `shifts[${i}]`
    if (typeof sh !== 'object' || sh === null) throw new TypeError(`${where} must be an object`)
    const t = typeof sh.templateId === 'string' ? index.get(sh.templateId) : undefined
    if (t === undefined) throw new RangeError(`${where} uses a template id that is not in the templates`)
    const p = prepared[t]
    const start = integerField(sh.startSlot, `${where}.startSlot`, 0, SCHEDULE_LIMITS.dayMinutes / SLOT_MINUTES)
    if (!p.starts.includes(start)) throw new RangeError(`${where}.startSlot is not an allowed start of template "${sh.templateId}"`)
    if (sh.endSlot !== start + p.len) throw new RangeError(`${where}.endSlot must be startSlot plus the template length`)
    const hasLunch = p.dur.length > p.nBreaks
    if (!Array.isArray(sh.breakSlots) || sh.breakSlots.length !== p.nBreaks) throw new RangeError(`${where}.breakSlots must list one start per template break`)
    if (hasLunch === (sh.lunchSlot === null)) throw new RangeError(`${where}.lunchSlot must be a slot exactly when the template has a lunch`)
    const slots = hasLunch ? [...sh.breakSlots, sh.lunchSlot] : [...sh.breakSlots]
    const offs = slots.map((s, a) => integerField(s, `${where} activity ${a} slot`, start, start + p.len) - start)
    if (!offsetsValid(p, offs)) throw new RangeError(`${where} breaks or lunch fall outside their windows, order or minimum gap`)
    if (++counts[t] > p.cap) throw new RangeError(`Template "${sh.templateId}" has more shifts than its maxShifts cap`)
    add(start, start + p.len, 1)
    offs.forEach((o, a) => add(start + o, start + o + p.dur[a], -1))
    paidSlots += p.paidSlots
  })
  const { rows, under, over } = coverage(input, ctx, sums)
  return {
    rows,
    totals: { shiftCount: shifts.length, paidAgentHours: paidSlots * SLOT_MINUTES / 60, underAgentHours: under, overAgentHours: over },
    finalCost: scheduleCost(goalSlots(input, ctx), sums, paidSlots),
  }
}

/**
 * Runs the same input and option checks as buildSchedule without building,
 * so a form can report template errors before a build is requested. Throws
 * the same RangeError or TypeError buildSchedule would.
 */
export function validateSchedule(input: ScheduleInput, options: ScheduleOptions = {}): void {
  validate(input, options)
}

/**
 * Builds a one-day schedule for one queue. Throws RangeError or TypeError on
 * invalid input, including a template whose rules cannot be satisfied.
 * Same input and options give the same output unless deadlineMs cuts the
 * search short.
 */
export function buildSchedule(input: ScheduleInput, options: ScheduleOptions = {}): ScheduleResult {
  const ctx = validate(input, options)
  const { prepared, k, now } = ctx
  const t0 = now()
  const timeUp = () => ctx.deadlineMs !== undefined && now() - t0 >= ctx.deadlineMs
  const nIntervals = input.required.length
  // Interval cost works on slot sums: target in agent-slots is k * target agents.
  const goal = goalSlots(input, ctx)
  const sums = new Int32Array(nIntervals)
  const intervalCost = (i: number, c: number) => intervalCostAt(goal[i], c)
  const applyRange = (from: number, to: number, sign: number) => {
    let delta = 0
    for (let s = from; s < to; s++) {
      const i = k === 1 ? s : s >> 1
      const before = intervalCost(i, sums[i])
      sums[i] += sign
      delta += intervalCost(i, sums[i]) - before
    }
    return delta
  }
  const applyShift = (sh: WorkShift, sign: number) => {
    const p = prepared[sh.t]
    let delta = applyRange(sh.start, sh.start + p.len, sign)
    for (let a = 0; a < sh.offs.length; a++) {
      const from = sh.start + sh.offs[a]
      delta += applyRange(from, from + p.dur[a], -sign)
    }
    return delta
  }
  /**
   * Places activities left to right against current coverage, each at the
   * feasible offset whose removal costs least (highest over-coverage first;
   * earliest wins ties). Leaves coverage unchanged and returns the coverage
   * cost delta of adding the shift, excluding paid cost.
   */
  const place = (t: number, start: number): { offs: number[]; delta: number } => {
    const p = prepared[t]
    const base = applyRange(start, start + p.len, 1)
    let best: { offs: number[]; delta: number } | null = null
    for (const v of p.variants) {
      const offs = new Array<number>(p.dur.length)
      let delta = base
      let next = 0
      for (let j = 0; j < v.seq.length; j++) {
        const a = v.seq[j]
        let bestX = -1
        let bestD = Infinity
        for (let x = Math.max(v.earliest[j], next); x <= v.latest[j]; x++) {
          const d = applyRange(start + x, start + x + p.dur[a], -1)
          applyRange(start + x, start + x + p.dur[a], 1)
          if (d < bestD - EPS) { bestD = d; bestX = x }
        }
        delta += applyRange(start + bestX, start + bestX + p.dur[a], -1)
        offs[a] = bestX
        next = bestX + p.dur[a] + p.gap
      }
      for (let a = 0; a < offs.length; a++) applyRange(start + offs[a], start + offs[a] + p.dur[a], 1)
      if (best === null || delta < best.delta - EPS) best = { offs, delta }
    }
    applyRange(start, start + p.len, -1)
    if (best === null) throw new Error('No feasible activity order; template validation should have rejected it')
    return best
  }
  const paidCost = (t: number) => PAID_WEIGHT * prepared[t].paidSlots
  const fullCost = (shifts: readonly WorkShift[]) => {
    let paid = 0
    for (const sh of shifts) paid += prepared[sh.t].paidSlots
    return scheduleCost(goal, sums, paid)
  }

  // Greedy: add the single best shift until nothing lowers cost or a cap is hit.
  const shifts: WorkShift[] = []
  const counts = prepared.map(() => 0)
  while (shifts.length < SCHEDULE_LIMITS.shifts && !timeUp()) {
    let best: WorkShift | null = null
    let bestD = -EPS
    for (let t = 0; t < prepared.length; t++) {
      if (counts[t] >= prepared[t].cap) continue
      const starts = prepared[t].starts
      for (let si = 0; si < starts.length; si++) {
        const r = place(t, starts[si])
        const d = r.delta + paidCost(t)
        if (d < bestD) { bestD = d; best = { t, si, start: starts[si], offs: r.offs } }
      }
    }
    if (best === null) break
    applyShift(best, 1)
    shifts.push(best)
    counts[best.t]++
  }
  const greedyCost = fullCost(shifts)

  // Local search: random moves, strict improvements only.
  const rand = mulberry32(ctx.seed)
  const pick = (n: number) => Math.floor(rand() * n)
  const T = prepared.length
  let iterations = 0
  const tryReplace = (idx: number, next: WorkShift) => {
    const old = shifts[idx]
    const d1 = applyShift(old, -1)
    const d2 = applyShift(next, 1)
    if (d1 + d2 + paidCost(next.t) - paidCost(old.t) < -EPS) {
      shifts[idx] = next
      counts[old.t]--
      counts[next.t]++
      return
    }
    applyShift(next, -1)
    applyShift(old, 1)
  }
  while (iterations < ctx.maxIterations && !timeUp()) {
    iterations++
    const move = shifts.length === 0 ? 4 : pick(5)
    if (move === 0) {
      // Start +/- one start step; keep offsets or re-place, whichever is cheaper.
      const idx = pick(shifts.length)
      const sh = shifts[idx]
      const p = prepared[sh.t]
      const si = sh.si + (rand() < 0.5 ? -1 : 1)
      if (si < 0 || si >= p.starts.length) continue
      const start = p.starts[si]
      applyShift(sh, -1)
      const kept = { t: sh.t, si, start, offs: sh.offs }
      const keptD = applyShift(kept, 1)
      applyShift(kept, -1)
      const r = place(sh.t, start)
      applyShift(sh, 1)
      tryReplace(idx, r.delta < keptD - EPS ? { t: sh.t, si, start, offs: r.offs } : kept)
    } else if (move === 1) {
      // Move one activity to its best valid offset within its window.
      const idx = pick(shifts.length)
      const sh = shifts[idx]
      const p = prepared[sh.t]
      if (sh.offs.length === 0) continue
      const a = pick(sh.offs.length)
      const cur = sh.start + sh.offs[a]
      let bestX = -1
      let bestD = -EPS
      const offs = [...sh.offs]
      for (let x = p.lo[a]; x <= p.hi[a]; x++) {
        if (x === sh.offs[a]) continue
        offs[a] = x
        if (!offsetsValid(p, offs)) continue
        const from = sh.start + x
        const d = applyRange(cur, cur + p.dur[a], 1) + applyRange(from, from + p.dur[a], -1)
        applyRange(from, from + p.dur[a], 1)
        applyRange(cur, cur + p.dur[a], -1)
        if (d < bestD) { bestD = d; bestX = x }
      }
      if (bestX < 0) continue
      applyRange(cur, cur + p.dur[a], 1)
      applyRange(sh.start + bestX, sh.start + bestX + p.dur[a], -1)
      offs[a] = bestX
      shifts[idx] = { ...sh, offs }
    } else if (move === 2) {
      // Swap to another template at its start nearest the current one.
      if (T < 2) continue
      const idx = pick(shifts.length)
      const sh = shifts[idx]
      // Draw from the other templates only, so no attempt is spent on a no-op swap.
      let t = pick(T - 1)
      if (t >= sh.t) t++
      if (counts[t] >= prepared[t].cap) continue
      const starts = prepared[t].starts
      let si = 0
      for (let j = 1; j < starts.length; j++) if (Math.abs(starts[j] - sh.start) < Math.abs(starts[si] - sh.start)) si = j
      applyShift(sh, -1)
      const r = place(t, starts[si])
      applyShift(sh, 1)
      tryReplace(idx, { t, si, start: starts[si], offs: r.offs })
    } else if (move === 3) {
      const idx = pick(shifts.length)
      const sh = shifts[idx]
      const d = applyShift(sh, -1) - paidCost(sh.t)
      if (d < -EPS) {
        shifts.splice(idx, 1)
        counts[sh.t]--
      } else {
        applyShift(sh, 1)
      }
    } else {
      if (shifts.length >= SCHEDULE_LIMITS.shifts) continue
      const t = pick(T)
      if (counts[t] >= prepared[t].cap) continue
      const si = pick(prepared[t].starts.length)
      const start = prepared[t].starts[si]
      const r = place(t, start)
      if (r.delta + paidCost(t) < -EPS) {
        const sh = { t, si, start, offs: r.offs }
        applyShift(sh, 1)
        shifts.push(sh)
        counts[t]++
      }
    }
  }
  const finalCost = fullCost(shifts)

  const { rows, under, over } = coverage(input, ctx, sums)
  let paidSlots = 0
  for (const sh of shifts) paidSlots += prepared[sh.t].paidSlots
  const ordered = [...shifts].sort((x, y) => x.start - y.start || x.t - y.t
    || x.offs.reduce((c, o, a) => c || o - y.offs[a], 0))
  return {
    shifts: ordered.map(sh => {
      const p = prepared[sh.t]
      return {
        templateId: input.templates[sh.t].id,
        startSlot: sh.start,
        endSlot: sh.start + p.len,
        breakSlots: sh.offs.slice(0, p.nBreaks).map(o => sh.start + o),
        lunchSlot: sh.offs.length > p.nBreaks ? sh.start + sh.offs[p.nBreaks] : null,
      }
    }),
    rows,
    totals: { shiftCount: shifts.length, paidAgentHours: paidSlots * SLOT_MINUTES / 60, underAgentHours: under, overAgentHours: over },
    greedyCost,
    finalCost,
    iterations,
  }
}
