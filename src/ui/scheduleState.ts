/**
 * Schedule tab form state and its conversion to engine templates.
 *
 * Drafts keep the text the user typed. Clock fields ("07:30") are times of
 * day; offset fields ("1:30") are hours and minutes after shift start;
 * minute fields are whole minutes. parseTemplates turns drafts into engine
 * templates relative to the forecast day's first interval, reporting format
 * errors per field; engine validation then reports rule conflicts.
 */
import type { ActivityRule, ShiftTemplate } from '../engine/schedule'
import { DEFAULT_UNPLANNED_SHRINKAGE, SCHEDULE_LIMITS, SLOT_MINUTES } from '../engine/schedule'

export interface ActivityDraft {
  /** Whole minutes. */
  minutes: string
  /** Window for the activity start, h:mm after shift start. */
  earliest: string
  latest: string
}

export interface LunchDraft extends ActivityDraft {
  paid: boolean
}

export interface TemplateDraft {
  /** Stable engine id, never shown. */
  id: string
  name: string
  /** Time on site, h:mm. */
  length: string
  /** Start window, clock times. */
  earliestStart: string
  latestStart: string
  stepMinutes: string
  breaks: ActivityDraft[]
  lunch: LunchDraft | null
  minGapMinutes: string
  /** Blank means no cap. */
  maxShifts: string
}

export interface ScheduleState {
  selectedDay: string | null
  /** Whole percent text. */
  shrinkagePct: string
  /** Null until the first edit: the default templates, fitted to the selected day. */
  templates: TemplateDraft[] | null
}

export const MAX_SHRINKAGE_PCT = SCHEDULE_LIMITS.unplannedShrinkage * 100

const brk = (earliest: string, latest: string): ActivityDraft => ({ minutes: '15', earliest, latest })

/** Clock minutes (after midnight) of a planning day and of its open hours inside it. */
export interface DayHours {
  dayStart: number
  dayEnd: number
  openStart: number
  openEnd: number
}

/**
 * Contact-center shift patterns: full-time and ten-hour days with two paid
 * 15-minute breaks around an unpaid 30-minute lunch, and a part-time shift
 * with one break.
 *
 * Start windows come from the open hours: when they are at least as long as
 * the shift, starts run from opening to the last start that ends at closing.
 * When they are shorter, the window widens inside the day so a shift still
 * spans the whole open period. A pattern longer than the day is left out; if
 * none fits, one break-free shift as long as the day is offered. Every
 * returned template passes validation for that day.
 */
export function defaultTemplates(hours: DayHours = { dayStart: 0, dayEnd: 24 * 60, openStart: 0, openEnd: 24 * 60 }): TemplateDraft[] {
  const { dayStart, dayEnd, openStart, openEnd } = hours
  const base: [number, Omit<TemplateDraft, 'earliestStart' | 'latestStart' | 'stepMinutes'>][] = [
    [510, {
      id: 't1', name: 'Full-time 8.5 h', length: '8:30',
      breaks: [brk('1:30', '2:30'), brk('6:00', '7:00')], lunch: { minutes: '30', earliest: '3:30', latest: '5:00', paid: false },
      minGapMinutes: '60', maxShifts: '',
    }],
    [240, {
      id: 't2', name: 'Part-time 4 h', length: '4:00',
      breaks: [brk('1:30', '2:30')], lunch: null, minGapMinutes: '60', maxShifts: '',
    }],
    [630, {
      id: 't3', name: 'Ten-hour 10.5 h', length: '10:30',
      breaks: [brk('1:30', '2:30'), brk('7:30', '8:30')], lunch: { minutes: '30', earliest: '4:00', latest: '5:30', paid: false },
      minGapMinutes: '60', maxShifts: '',
    }],
  ]
  const fitted = base.flatMap(([onSite, t]) => {
    if (onSite > dayEnd - dayStart) return []
    const earliest = openEnd - openStart >= onSite ? openStart : Math.max(dayStart, openEnd - onSite)
    const latest = openEnd - openStart >= onSite ? openEnd - onSite : Math.min(openStart, dayEnd - onSite)
    // A 30-minute step unless only a 15-minute step reaches the latest start.
    const step = (latest - earliest) % 30 === 0 ? '30' : '15'
    return [{ ...t, earliestStart: fmtClock(earliest), latestStart: fmtClock(latest), stepMinutes: step }]
  })
  if (fitted.length > 0) return fitted
  // The step may not exceed the day, which can be a single 15-minute interval.
  return [{
    id: 't1', name: 'Day-length shift', length: fmtDuration(dayEnd - dayStart), earliestStart: fmtClock(dayStart), latestStart: fmtClock(dayStart),
    stepMinutes: String(Math.min(30, dayEnd - dayStart)), breaks: [], lunch: null, minGapMinutes: '0', maxShifts: '',
  }]
}

export const emptyScheduleState = (): ScheduleState => ({
  selectedDay: null,
  shrinkagePct: String(DEFAULT_UNPLANNED_SHRINKAGE * 100),
  templates: null,
})

/** Next unused engine id. */
export function nextTemplateId(templates: readonly TemplateDraft[]): string {
  const used = new Set(templates.map(t => t.id))
  let n = templates.length + 1
  while (used.has(`t${n}`)) n++
  return `t${n}`
}

/** Minutes as "h:mm", e.g. 510 -> "8:30". */
export function fmtDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** Minutes after midnight as "HH:MM". */
export function fmtClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** One problem with a template; field names the input it belongs to, or null for whole-template rules. */
export interface FieldError {
  field: string | null
  text: string
}

export interface ParsedTemplates {
  templates: ShiftTemplate[] | null
  /** Keyed by draft id. */
  errors: Record<string, FieldError[]>
}

const HM = /^(\d{1,2}):(\d{2})$/

/**
 * Parses drafts into engine templates. `dayStartMinutes` is the first
 * interval's clock time and `dayMinutes` the day's length; clock fields
 * become minutes after the first interval.
 */
export function parseTemplates(drafts: readonly TemplateDraft[], dayStartMinutes: number, dayMinutes: number): ParsedTemplates {
  const errors: Record<string, FieldError[]> = {}
  const templates: ShiftTemplate[] = []
  for (const d of drafts) {
    const list: FieldError[] = []
    const fail = (field: string, text: string) => { list.push({ field, text }); return 0 }
    const clock = (field: string, label: string, text: string) => {
      const m = HM.exec(text.trim())
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[2]) % SLOT_MINUTES !== 0) {
        return fail(field, `${label}: enter a clock time on the quarter hour, such as 07:30.`)
      }
      const minutes = Number(m[1]) * 60 + Number(m[2])
      if (minutes < dayStartMinutes) return fail(field, `${label}: ${text.trim()} is before this day's first interval at ${fmtClock(dayStartMinutes)}.`)
      return minutes - dayStartMinutes
    }
    const duration = (field: string, label: string, text: string) => {
      const m = HM.exec(text.trim())
      if (!m || Number(m[2]) > 59 || Number(m[2]) % SLOT_MINUTES !== 0) {
        return fail(field, `${label}: enter hours and minutes in 15-minute steps, such as 1:30.`)
      }
      return Number(m[1]) * 60 + Number(m[2])
    }
    const minutes = (field: string, label: string, text: string, min: number) => {
      const t = text.trim()
      const n = Number(t)
      if (t === '' || !Number.isInteger(n) || n < min || n % SLOT_MINUTES !== 0) {
        return fail(field, `${label}: enter whole minutes in steps of 15${min === 0 ? ', or 0' : ''}, such as 15 or 30.`)
      }
      return n
    }
    const activity = (prefix: string, label: string, a: ActivityDraft): ActivityRule => ({
      minutes: minutes(`${prefix}-minutes`, `${label} length`, a.minutes, SLOT_MINUTES),
      earliestOffset: duration(`${prefix}-earliest`, `${label} window opens`, a.earliest),
      latestOffset: duration(`${prefix}-latest`, `${label} window closes`, a.latest),
    })

    const name = d.name.trim()
    if (!name) fail('name', 'Name: enter a template name.')
    else if (name.length > SCHEDULE_LIMITS.nameLength) fail('name', `Name: use at most ${SCHEDULE_LIMITS.nameLength} characters.`)
    const lengthMinutes = duration('length', 'Shift length', d.length)
    if (lengthMinutes === 0 && !list.some(e => e.field === 'length')) fail('length', 'Shift length: enter a length of at least 0:15.')
    const earliest = clock('earliestStart', 'Earliest start', d.earliestStart)
    const latest = clock('latestStart', 'Latest start', d.latestStart)
    const step = minutes('stepMinutes', 'Start every', d.stepMinutes, SLOT_MINUTES)
    const minGap = minutes('minGapMinutes', 'Minimum gap', d.minGapMinutes, 0)
    const breaks = d.breaks.map((b, i) => activity(`break-${i}`, `Break ${i + 1}`, b))
    const lunch = d.lunch ? { ...activity('lunch', 'Lunch', d.lunch), paid: d.lunch.paid } : undefined
    let maxShifts: number | undefined
    if (d.maxShifts.trim() !== '') {
      const n = Number(d.maxShifts.trim())
      if (!Number.isInteger(n) || n < 0 || n > SCHEDULE_LIMITS.shifts) fail('maxShifts', `Max shifts: enter a whole number from 0 to ${SCHEDULE_LIMITS.shifts}, or leave blank for no cap.`)
      else maxShifts = n
    }
    if (list.every(e => e.field !== 'latestStart' && e.field !== 'length') && latest + lengthMinutes > dayMinutes) {
      fail('latestStart', `Latest start: a shift of ${fmtDuration(lengthMinutes)} starting at ${d.latestStart.trim()} runs past ${fmtClock(dayStartMinutes + dayMinutes)}, when this day's last interval ends. Shifts cannot run overnight.`)
    }
    if (list.length > 0) errors[d.id] = list
    else templates.push({
      id: d.id, name, lengthMinutes, start: { earliest, latest, step }, breaks,
      ...(lunch && { lunch }), minGapMinutes: minGap, ...(maxShifts !== undefined && { maxShifts }),
    })
  }
  return { templates: Object.keys(errors).length === 0 ? templates : null, errors }
}

/** Paid time of a draft as "h:mm" (time on site minus an unpaid lunch), or null while those fields do not parse. */
export function draftPaidTime(d: TemplateDraft): string | null {
  const m = HM.exec(d.length.trim())
  const unpaid = d.lunch && !d.lunch.paid ? Number(d.lunch.minutes.trim()) : 0
  if (!m || Number(m[2]) > 59 || !Number.isInteger(unpaid) || unpaid < 0) return null
  const length = Number(m[1]) * 60 + Number(m[2])
  return unpaid <= length ? fmtDuration(length - unpaid) : null
}

const FIELD_WORDS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/breaks\[(\d+)\]\.minutes/, m => `Break ${Number(m[1]) + 1} length`],
  [/breaks\[(\d+)\]\.earliestOffset/, m => `Break ${Number(m[1]) + 1} window opening`],
  [/breaks\[(\d+)\](\.| )latestOffset/, m => `Break ${Number(m[1]) + 1} window closing`],
  [/breaks\[(\d+)\]/, m => `Break ${Number(m[1]) + 1}`],
  [/lunch\.minutes/, () => 'Lunch length'],
  [/lunch\.earliestOffset/, () => 'Lunch window opening'],
  [/^lunch(\.| )latestOffset/, () => 'Lunch window closing'],
  [/^lunch\b/, () => 'Lunch'],
  [/lengthMinutes/, () => 'Shift length'],
  [/start\.earliest/, () => 'Earliest start'],
  [/start\.latest/, () => 'Latest start'],
  [/start\.step/, () => 'Start step'],
  [/minGapMinutes/, () => 'Minimum gap'],
  [/maxShifts/, () => 'Max shifts'],
  [/paid minutes/, () => 'Paid time'],
  [/\bearliestOffset\b/, () => 'its window opening'],
  [/plus minutes/, () => 'plus its length'],
]

/**
 * Engine validation message in the form's words. Returns the draft id the
 * message is about, or null for errors that are not about one template.
 */
export function describeEngineError(message: string, drafts: readonly TemplateDraft[]): { templateId: string | null; text: string } {
  let text = message
  let templateId: string | null = null
  const named = /^Template "([^"]*)" /.exec(text)
  const indexed = /^templates\[(\d+)\] /.exec(text)
  if (named && drafts.some(d => d.id === named[1])) {
    templateId = named[1]
    text = text.slice(named[0].length)
  } else if (indexed && drafts[Number(indexed[1])]) {
    templateId = drafts[Number(indexed[1])].id
    text = text.slice(indexed[0].length)
  }
  for (const [pattern, words] of FIELD_WORDS) {
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text))) text = text.slice(0, m.index) + words(m) + text.slice(m.index + m[0].length)
  }
  if (text.startsWith('cannot be satisfied')) text = 'This template ' + text
  text = text.charAt(0).toUpperCase() + text.slice(1)
  return { templateId, text: /[.!?]$/.test(text) ? text : text + '.' }
}
