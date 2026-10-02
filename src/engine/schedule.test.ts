import { describe, expect, it } from 'vitest'
import { buildSchedule, mulberry32, OVER_WEIGHT, PAID_WEIGHT, paidMinutes, SCHEDULE_LIMITS, UNDER_WEIGHT } from './schedule'
import type { ActivityRule, ScheduleInput, ScheduleResult, ShiftTemplate } from './schedule'

/** Two-hour shift starting at day start with no activities. */
function plain(overrides: Partial<ShiftTemplate> = {}): ShiftTemplate {
  return { id: 'a', name: 'A', lengthMinutes: 120, start: { earliest: 0, latest: 0, step: 15 }, breaks: [], minGapMinutes: 0, ...overrides }
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return { required: Array(8).fill(2), intervalMinutes: 15, dayStart: '2026-01-06T08:00', unplannedShrinkage: 0, templates: [plain()], ...overrides }
}

describe('buildSchedule hand-checked cases', () => {
  it('flat requirement of 2 on a 2-hour day: two whole-day shifts, cost is paid slots only', () => {
    const r = buildSchedule(input())
    expect(r.shifts).toEqual([
      { templateId: 'a', startSlot: 0, endSlot: 8, breakSlots: [], lunchSlot: null },
      { templateId: 'a', startSlot: 0, endSlot: 8, breakSlots: [], lunchSlot: null },
    ])
    expect(r.rows.map(row => row.scheduled)).toEqual(Array(8).fill(2))
    expect(r.finalCost).toBeCloseTo(PAID_WEIGHT * 16, 12)
    expect(r.totals).toEqual({ shiftCount: 2, paidAgentHours: 4, underAgentHours: 0, overAgentHours: 0 })
    expect(r.rows[0].ts).toBe('2026-01-06T08:00:00')
    expect(r.rows[7].ts).toBe('2026-01-06T09:45:00')
  })

  it('target 2.5 after 20% shrinkage: a third shift costs 0.5 over per slot instead of 0.5 under', () => {
    const r = buildSchedule(input({ unplannedShrinkage: 0.2 }))
    expect(r.shifts).toHaveLength(3)
    expect(r.rows[0].target).toBeCloseTo(2.5, 12)
    // 8 slots x 0.5 agent over, plus 24 paid slots.
    expect(r.finalCost).toBeCloseTo(OVER_WEIGHT * 4 + PAID_WEIGHT * 24, 12)
    expect(r.totals.overAgentHours).toBeCloseTo(1, 12)
    expect(r.totals.underAgentHours).toBe(0)
  })

  it('a 15-minute break counts as half an agent in a 30-minute interval', () => {
    const fixedBreak = plain({ breaks: [{ minutes: 15, earliestOffset: 30, latestOffset: 30 }], maxShifts: 1 })
    const half = buildSchedule(input({ required: [1, 1, 1, 1], intervalMinutes: 30, templates: [fixedBreak] }))
    expect(half.shifts[0].breakSlots).toEqual([2])
    expect(half.rows.map(row => row.scheduled)).toEqual([1, 0.5, 1, 1])
    expect(half.rows[1].under).toBe(0.5)
    expect(half.totals.underAgentHours).toBe(0.25)
    // One agent-slot under, eight paid slots.
    expect(half.finalCost).toBeCloseTo(UNDER_WEIGHT * 1 + PAID_WEIGHT * 8, 12)
    const quarter = buildSchedule(input({ required: Array(8).fill(1), templates: [fixedBreak] }))
    expect(quarter.rows.map(row => row.scheduled)).toEqual([1, 1, 0, 1, 1, 1, 1, 1])
  })

  it('places a break where coverage is highest within its window', () => {
    const t = plain({ breaks: [{ minutes: 15, earliestOffset: 30, latestOffset: 90 }], maxShifts: 1 })
    const r = buildSchedule(input({ required: [1, 1, 1, 0, 1, 1, 1, 1], templates: [t] }), { maxIterations: 0 })
    expect(r.shifts[0].breakSlots).toEqual([3])
    expect(r.finalCost).toBeCloseTo(PAID_WEIGHT * 8, 12)
  })

  it('zero requirement builds zero shifts', () => {
    const r = buildSchedule(input({ required: Array(8).fill(0) }))
    expect(r.shifts).toEqual([])
    expect(r.finalCost).toBe(0)
    expect(r.greedyCost).toBe(0)
  })

  it('unpaid lunch is excluded from paid hours; breaks and paid lunch are included', () => {
    const lunch = { minutes: 30, earliestOffset: 45, latestOffset: 45 }
    const unpaid = plain({ lunch: { ...lunch, paid: false } })
    expect(paidMinutes(unpaid)).toBe(90)
    expect(paidMinutes(plain({ lunch: { ...lunch, paid: true } }))).toBe(120)
    const r = buildSchedule(input({ required: Array(8).fill(1), templates: [{ ...unpaid, maxShifts: 1 }] }))
    expect(r.totals.paidAgentHours).toBe(1.5)
    expect(r.shifts[0].lunchSlot).toBe(3)
  })

  it('respects maxShifts and lets the cheaper template win', () => {
    const r = buildSchedule(input({ required: Array(8).fill(5), templates: [plain({ maxShifts: 3 }), plain({ id: 'b', lunch: { minutes: 15, earliestOffset: 60, latestOffset: 60, paid: false }, maxShifts: 1 })] }))
    expect(r.shifts.filter(s => s.templateId === 'a')).toHaveLength(3)
    expect(r.shifts.filter(s => s.templateId === 'b')).toHaveLength(1)
  })

  it('maxIterations 0 returns the greedy schedule; an expired deadline stops the build', () => {
    const r = buildSchedule(input(), { maxIterations: 0 })
    expect(r.iterations).toBe(0)
    expect(r.finalCost).toBe(r.greedyCost)
    let clock = 0
    const timed = buildSchedule(input(), { deadlineMs: 5, now: () => (clock += 10) })
    expect(timed.shifts).toEqual([])
    expect(timed.iterations).toBe(0)
  })

  it('timestamps roll over midnight inside a 24-hour day', () => {
    const r = buildSchedule(input({ required: Array(48).fill(0), intervalMinutes: 30, dayStart: '2026-12-31T22:00:00' }))
    expect(r.rows[3].ts).toBe('2026-12-31T23:30:00')
    expect(r.rows[4].ts).toBe('2027-01-01T00:00:00')
  })
})

describe('buildSchedule validation', () => {
  const brk: ActivityRule = { minutes: 15, earliestOffset: 30, latestOffset: 60 }
  it.each<[string, Partial<ScheduleInput>, string]>([
    ['interval length', { intervalMinutes: 20 as 15 }, 'intervalMinutes'],
    ['empty day', { required: [] }, 'required must list'],
    ['day over 24 hours', { required: Array(97).fill(0) }, 'required must list'],
    ['negative requirement', { required: [1, -1] }, 'required[1]'],
    ['NaN requirement', { required: [Number.NaN] }, 'required[0]'],
    ['huge requirement', { required: [501] }, 'required[0]'],
    ['shrinkage', { unplannedShrinkage: 0.81 }, 'unplannedShrinkage'],
    ['day start off boundary', { dayStart: '2026-01-06T08:10' }, 'dayStart'],
    ['invalid date', { dayStart: '2026-02-30T08:00' }, 'calendar'],
    ['no templates', { templates: [] }, 'templates must list'],
    ['13 templates', { templates: Array.from({ length: 13 }, (_, i) => plain({ id: `t${i}` })) }, 'templates must list'],
    ['duplicate id', { templates: [plain(), plain()] }, 'more than once'],
    ['blank id', { templates: [plain({ id: ' ' })] }, '.id'],
    ['length not multiple of 15', { templates: [plain({ lengthMinutes: 100 })] }, 'lengthMinutes'],
    ['shift past day end', { templates: [plain({ start: { earliest: 0, latest: 15, step: 15 } })] }, 'ends after'],
    ['latest before earliest', { templates: [plain({ lengthMinutes: 60, start: { earliest: 30, latest: 15, step: 15 } })] }, 'start.latest'],
    ['zero step', { templates: [plain({ start: { earliest: 0, latest: 0, step: 0 } })] }, 'start.step'],
    ['gap off grid', { templates: [plain({ minGapMinutes: 10 })] }, 'minGapMinutes'],
    ['five breaks', { templates: [plain({ breaks: Array(5).fill(brk) })] }, 'at most 4'],
    ['break window reversed', { templates: [plain({ breaks: [{ ...brk, earliestOffset: 60, latestOffset: 30 }] })] }, 'latestOffset must not be before'],
    ['break past shift end', { templates: [plain({ breaks: [{ ...brk, latestOffset: 120 }] })] }, 'past shift end'],
    ['zero-minute break', { templates: [plain({ breaks: [{ ...brk, minutes: 0 }] })] }, 'minutes'],
    ['lunch without paid flag', { templates: [plain({ lunch: { ...brk } as never })] }, 'paid flag'],
    ['negative cap', { templates: [plain({ maxShifts: -1 })] }, 'maxShifts'],
    ['fractional cap', { templates: [plain({ maxShifts: 1.5 })] }, 'maxShifts'],
  ])('rejects %s', (_, overrides, message) => {
    expect(() => buildSchedule(input(overrides))).toThrow(message)
    expect(() => buildSchedule(input(overrides))).toThrow(RangeError)
  })

  it('rejects templates whose rules cannot be satisfied', () => {
    // 15 gap + 15 break + 15 gap + 15 break + 15 gap = 75 minutes > 60.
    const crowded = plain({ lengthMinutes: 60, breaks: [{ minutes: 15, earliestOffset: 0, latestOffset: 45 }, { minutes: 15, earliestOffset: 0, latestOffset: 45 }], minGapMinutes: 15 })
    expect(() => buildSchedule(input({ templates: [crowded] }))).toThrow('cannot be satisfied')
    // Second break's window ends before the first break's can start.
    const reversed = plain({ breaks: [{ minutes: 15, earliestOffset: 60, latestOffset: 60 }, { minutes: 15, earliestOffset: 15, latestOffset: 15 }] })
    expect(() => buildSchedule(input({ templates: [reversed] }))).toThrow('cannot be satisfied')
    // Lunch overlaps every possible break position once the gap is applied.
    const blocked = plain({ breaks: [{ minutes: 15, earliestOffset: 45, latestOffset: 45 }], lunch: { minutes: 30, earliestOffset: 45, latestOffset: 60, paid: false }, minGapMinutes: 15 })
    expect(() => buildSchedule(input({ templates: [blocked] }))).toThrow('cannot be satisfied')
  })

  it('rejects invalid options', () => {
    expect(() => buildSchedule(input(), { seed: -1 })).toThrow('seed')
    expect(() => buildSchedule(input(), { maxIterations: 1.5 })).toThrow('maxIterations')
    expect(() => buildSchedule(input(), { deadlineMs: 0 })).toThrow('deadlineMs')
  })
})

/**
 * Random template. Usually built around a known valid placement with windows
 * widened around it; one time in four the windows are drawn independently,
 * so the template may have no valid placement at all. Windows stay at most
 * nine slots wide so a brute-force feasibility check stays cheap.
 */
function randomTemplate(rand: () => number, id: string, dayMinutes: number): ShiftTemplate {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  const lengthSlots = int(4, Math.min(dayMinutes / 15, 48))
  const gap = int(0, 4)
  const latestStart = int(0, dayMinutes / 15 - lengthSlots)
  const earliestStart = int(0, latestStart)
  const step = 15 * int(1, 8)
  const nBreaks = int(0, 4)
  const hasLunch = rand() < 0.5
  const durs = [...Array.from({ length: nBreaks }, () => 1), ...(hasLunch ? [int(2, 4)] : [])]
  const optional = {
    ...(rand() < 0.4 && { maxShifts: int(0, 15) }),
  }
  if (rand() < 0.25) {
    const free = (minutes: number): ActivityRule => {
      const maxStart = lengthSlots - minutes / 15
      const earliest = int(0, maxStart)
      return { minutes, earliestOffset: 15 * earliest, latestOffset: 15 * Math.min(maxStart, earliest + int(0, 5)) }
    }
    return {
      id, name: id, lengthMinutes: lengthSlots * 15,
      start: { earliest: earliestStart * 15, latest: latestStart * 15, step },
      breaks: Array.from({ length: nBreaks }, () => free(15)),
      ...(hasLunch && { lunch: { ...free(durs[durs.length - 1] * 15), paid: rand() < 0.5 } }),
      minGapMinutes: gap * 15,
      ...optional,
    }
  }
  // Drop breaks first (lunch is last) until a sequential placement fits.
  while (durs.length && durs.reduce((s, d) => s + d + gap, gap) > lengthSlots) durs.shift()
  const breaksKept = hasLunch && durs.length > 0 ? durs.length - 1 : durs.length
  const lunchKept = hasLunch && durs.length > 0
  const order = Array.from({ length: breaksKept }, (_, i) => i)
  if (lunchKept) order.splice(int(0, breaksKept), 0, -1)
  let slack = lengthSlots - durs.reduce((s, d) => s + d + gap, gap)
  let at = gap
  const placed = new Map<number, number>()
  for (const a of order) {
    const extra = int(0, slack)
    slack -= extra
    at += extra
    placed.set(a, at)
    at += (a === -1 ? durs[durs.length - 1] : 1) + gap
  }
  const windowFor = (a: number, minutes: number): ActivityRule => {
    const pos = placed.get(a) as number
    const maxStart = lengthSlots - minutes / 15
    return { minutes, earliestOffset: 15 * Math.max(0, pos - int(0, 4)), latestOffset: 15 * Math.min(maxStart, pos + int(0, 4)) }
  }
  return {
    id, name: id, lengthMinutes: lengthSlots * 15,
    start: { earliest: earliestStart * 15, latest: latestStart * 15, step },
    breaks: Array.from({ length: breaksKept }, (_, i) => windowFor(i, 15)),
    ...(lunchKept && { lunch: { ...windowFor(-1, durs[durs.length - 1] * 15), paid: rand() < 0.5 } }),
    minGapMinutes: gap * 15,
    ...optional,
  }
}

/**
 * Brute force from the template definition: tries every combination of
 * activity starts inside their windows and accepts the first one where breaks
 * keep template order, nothing overlaps, and the minimum gap holds between
 * activities and at both shift edges.
 */
function feasibleByBruteForce(t: ShiftTemplate): boolean {
  const acts: ActivityRule[] = [...t.breaks, ...(t.lunch ? [t.lunch] : [])]
  const chosen: number[] = []
  const ok = () => {
    for (let b = 1; b < t.breaks.length; b++) if (chosen[b] <= chosen[b - 1]) return false
    const order = acts.map((_, i) => i).sort((x, y) => chosen[x] - chosen[y])
    let freeFrom = t.minGapMinutes
    for (const i of order) {
      if (chosen[i] < freeFrom) return false
      freeFrom = chosen[i] + acts[i].minutes + t.minGapMinutes
    }
    return freeFrom <= t.lengthMinutes
  }
  const search = (i: number): boolean => {
    if (i === acts.length) return ok()
    for (let off = acts[i].earliestOffset; off <= acts[i].latestOffset; off += 15) {
      chosen[i] = off
      if (search(i + 1)) return true
    }
    return false
  }
  return search(0)
}

function randomCase(seed: number): ScheduleInput {
  const rand = mulberry32(seed)
  const intervalMinutes = rand() < 0.5 ? 15 : 30
  const dayMinutes = 15 * (16 + Math.floor(rand() * 81))
  const count = Math.floor(dayMinutes / intervalMinutes)
  const peak = rand() < 0.1 ? 0 : 1 + rand() * 40
  const center = rand() * count
  const required = Array.from({ length: count }, (_, i) =>
    Math.max(0, Math.round(peak * Math.exp(-((i - center) ** 2) / (count * 2)) + (rand() - 0.5) * 3)))
  const templates = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => randomTemplate(rand, `t${i}`, count * intervalMinutes))
  return { required, intervalMinutes, dayStart: '2026-03-02T06:00', unplannedShrinkage: rand() * 0.4, templates }
}

/** Independent rule check written from the template definition, not the engine. */
function ruleViolations(c: ScheduleInput, r: ScheduleResult): string[] {
  const errors: string[] = []
  const daySlots = c.required.length * c.intervalMinutes / 15
  const used = new Map<string, number>()
  for (const s of r.shifts) {
    const t = c.templates.find(x => x.id === s.templateId)
    if (!t) { errors.push(`unknown template ${s.templateId}`); continue }
    used.set(t.id, (used.get(t.id) ?? 0) + 1)
    const startMin = s.startSlot * 15
    if (startMin < t.start.earliest || startMin > t.start.latest || (startMin - t.start.earliest) % t.start.step) errors.push('start outside window')
    if (s.endSlot - s.startSlot !== t.lengthMinutes / 15) errors.push('wrong length')
    if (s.startSlot < 0 || s.endSlot > daySlots) errors.push('outside day')
    const acts = t.breaks.map((b, i) => ({ rule: b, slot: s.breakSlots[i] }))
    if (s.breakSlots.length !== t.breaks.length) errors.push('break count')
    if (t.lunch) acts.push({ rule: t.lunch, slot: s.lunchSlot as number })
    else if (s.lunchSlot !== null) errors.push('unexpected lunch')
    for (const a of acts) {
      const off = (a.slot - s.startSlot) * 15
      if (off < a.rule.earliestOffset || off > a.rule.latestOffset) errors.push('activity outside window')
    }
    for (let i = 1; i < s.breakSlots.length; i++) if (s.breakSlots[i] <= s.breakSlots[i - 1]) errors.push('break order')
    const sorted = [...acts].sort((x, y) => x.slot - y.slot)
    let freeFrom = s.startSlot * 15 + t.minGapMinutes
    for (const a of sorted) {
      if (a.slot * 15 < freeFrom) errors.push('overlap or gap')
      freeFrom = a.slot * 15 + a.rule.minutes + t.minGapMinutes
    }
    if (freeFrom > s.endSlot * 15) errors.push('end gap')
  }
  for (const t of c.templates) if ((used.get(t.id) ?? 0) > (t.maxShifts ?? SCHEDULE_LIMITS.shifts)) errors.push(`cap ${t.id}`)
  if (r.shifts.length > SCHEDULE_LIMITS.shifts) errors.push('total cap')
  return errors
}

describe('buildSchedule properties over random seeds', () => {
  const seeds = Array.from({ length: 80 }, (_, i) => i + 1)
  const firstInfeasible = (c: ScheduleInput) => c.templates.find(t => !feasibleByBruteForce(t))

  it('the generator covers infeasible templates, long start steps and long gaps', () => {
    const cases = seeds.map(randomCase)
    const templates = cases.flatMap(c => c.templates)
    expect(cases.filter(c => firstInfeasible(c)).length).toBeGreaterThanOrEqual(5)
    expect(cases.filter(c => !firstInfeasible(c)).length).toBeGreaterThanOrEqual(40)
    expect(templates.some(t => t.start.step > 60)).toBe(true)
    expect(templates.some(t => t.minGapMinutes > 30)).toBe(true)
  })

  it.each(seeds)('seed %i: valid shifts, recount matches, cost never rises, deterministic', seed => {
    const c = randomCase(seed)
    const options = { seed, maxIterations: 3000 }
    const bad = firstInfeasible(c)
    if (bad) {
      // Rejection must agree with the brute-force check, naming the first infeasible template.
      expect(() => buildSchedule(c, options)).toThrow(`Template "${bad.id}" cannot be satisfied`)
      return
    }
    const r = buildSchedule(c, options)
    expect(buildSchedule(c, { seed, maxIterations: 0 }).finalCost).toBe(r.greedyCost)
    expect(ruleViolations(c, r)).toEqual([])
    // Recount coverage per slot from shifts, then average into intervals.
    const k = c.intervalMinutes / 15
    const slots = new Array(c.required.length * k).fill(0)
    for (const s of r.shifts) {
      const t = c.templates.find(x => x.id === s.templateId) as ShiftTemplate
      for (let x = s.startSlot; x < s.endSlot; x++) slots[x]++
      const acts = [...t.breaks.map((b, i) => [s.breakSlots[i], b.minutes]), ...(t.lunch ? [[s.lunchSlot as number, t.lunch.minutes]] : [])]
      for (const [at, minutes] of acts) for (let x = at; x < at + minutes / 15; x++) slots[x]--
    }
    expect(slots.every(n => n >= 0)).toBe(true)
    let cost = 0
    r.rows.forEach((row, i) => {
      const covered = slots.slice(i * k, i * k + k).reduce((a, b) => a + b, 0) / k
      expect(row.scheduled).toBe(covered)
      const target = c.required[i] / (1 - (c.unplannedShrinkage as number))
      cost += k * (UNDER_WEIGHT * Math.max(0, target - covered) + OVER_WEIGHT * Math.max(0, covered - target))
    })
    cost += PAID_WEIGHT * r.shifts.reduce((s, sh) => s + paidMinutes(c.templates.find(x => x.id === sh.templateId) as ShiftTemplate) / 15, 0)
    expect(r.finalCost).toBeCloseTo(cost, 6)
    expect(r.finalCost).toBeLessThanOrEqual(r.greedyCost)
    expect(buildSchedule(c, options)).toEqual(r)
  })
})
