import { describe, expect, it } from 'vitest'
import { generateSampleData } from '../engine/sampleData'
import { buildCapacityPlan } from '../engine/capacity'
import { capacityConfig, emptyCapacityState, exampleCapacityState } from './capacityState'
import { initialStaffing, parseProject, serializeProject, validateProject } from './project'
import type { Project } from './project'
import type { CapacityState } from './capacityState'

describe('intraday project state and migration', () => {
  const filled = () => {
    const p = fixture()
    p.intradayByQueue = { ['__proto__']: { selectedDay: '2026-01-06', days: {
      '2026-01-06': { cutoff: 1, actuals: { '2026-01-06T08:00:00': '0' }, scheduled: { '2026-01-06T08:00:00': '12.5' } },
      '2026-01-07': { cutoff: 0, actuals: { '2026-01-07T08:00:00': '123' }, scheduled: { '2026-01-07T08:00:00': '' } },
    } } }
    return p
  }
  it('round-trips own reserved queues, selected day, observed zero, future text and blank staffing', () => {
    const p = filled()
    expect(parseProject(serializeProject(p))).toEqual(p)
  })
  it('preserves inactive actual drafts but validates them when the cutoff includes them', () => {
    const p = filled()
    const day = p.intradayByQueue.__proto__.days['2026-01-06']
    day.actuals['2026-01-06T08:00:00'] = '-1'
    day.cutoff = 0
    expect(parseProject(serializeProject(p))).toEqual(p)
    day.cutoff = 1
    expect(() => serializeProject(p)).toThrow(/Intraday actuals/)
    day.cutoff = 0
    day.scheduled['2026-01-06T08:00:00'] = '-1'
    expect(() => serializeProject(p)).toThrow(/Intraday scheduled/)
  })
  it('migrates exact v1 fields through v2 and v3 to v4, preserving all older settings', () => {
    const p = fixture()
    const { intradayByQueue: _intraday, scheduleByQueue: _schedules, ...old } = p
    const v1 = { ...old, version: 1, capacityByQueue: { ['__proto__']: v2Capacity() } }
    expect(parseProject(JSON.stringify(v1))).toEqual(p)
    expect(() => parseProject(JSON.stringify({ ...v1, intradayByQueue: { bad: 1 } }))).toThrow('fields')
    expect(() => parseProject(JSON.stringify({ ...old, version: 1 }))).toThrow('fields')
  })
  it.each([
    ['unknown queue', (p: Project) => { p.intradayByQueue.missing = p.intradayByQueue.__proto__ }],
    ['invalid date', (p: Project) => { p.intradayByQueue.__proto__.selectedDay = '2026-02-29' }],
    ['past date', (p: Project) => { p.intradayByQueue.__proto__.selectedDay = '2026-01-05' }],
    ['beyond window', (p: Project) => { p.intradayByQueue.__proto__.selectedDay = '2026-02-03' }],
    ['unknown interval', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].actuals['2026-01-06T09:00:00'] = '1' }],
    ['wrong interval day', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].actuals['2026-01-07T08:00:00'] = '1' }],
    ['fractional cutoff', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].cutoff = .5 }],
    ['long cutoff', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].cutoff = 2 }],
    ['invalid observed actual', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].actuals['2026-01-06T08:00:00'] = '-1' }],
    ['large staffing', (p: Project) => { p.intradayByQueue.__proto__.days['2026-01-06'].scheduled['2026-01-06T08:00:00'] = '501' }],
    ['unexpected fields', (p: Project) => { Object.assign(p.intradayByQueue.__proto__, { arbitrary: {} }) }],
  ])('rejects %s atomically', (_label, change) => {
    const p = filled(); change(p)
    expect(() => serializeProject(p)).toThrow()
    expect(() => parseProject(JSON.stringify(p))).toThrow()
  })
})

export function fixture(): Project {
  return { schema: 'wfm-project', version: 4, intradayByQueue: {}, scheduleByQueue: {}, name: 'September plan', sourceLabel: 'history.csv',
    records: [{ ts: '2026-01-05T08:00', queue: '__proto__', offered: 42, aht: 300 }],
    queue: '__proto__', horizon: 28, staffing: initialStaffing('#s=v1;s:85;v:10&r=27.50'),
    capacityByQueue: { ['__proto__']: exampleCapacityState() } }
}
/** A version 2 capacity draft: one class flattened into the inputs. Defaults match the illustrative example. */
function v2Capacity(inputs: Record<string, string> = {}) {
  return { inputs: { startingHeadcount: '100', weeklyAttritionPct: '0', paidHoursPerWeek: '40', shrinkagePct: '20', hourlyCost: '25', classSize: '10', startWeek: '2', trainingWeeks: '2', rampWeeks: '2', ...inputs },
    demand: Array.from({ length: 13 }, (_, i) => i < 6 ? '78' : '84'), sources: Array(13).fill('example'), startDate: null, seedPaidHours: null }
}
function v2Project(capacityByQueue: Record<string, unknown>) {
  const { scheduleByQueue: _schedules, ...v3 } = fixture()
  return JSON.stringify({ ...v3, version: 2, capacityByQueue })
}
describe('capacity version 3 and v2 migration', () => {
  it('round-trips several classes with nesting, history provenance and growth', () => {
    const p = fixture(), c = exampleCapacityState()
    c.classes.push({ size: '4.5', startWeek: '5', trainingWeeks: '1', nestingWeeks: '2', nestingProductivityPct: '60', rampWeeks: '3' }, { size: '', startWeek: '', trainingWeeks: '', nestingWeeks: '', nestingProductivityPct: '', rampWeeks: '' })
    c.inputs.newHireAttritionPct = '1.5'; c.inputs.weeklyGrowthPct = '-0.25'
    c.sources[0] = 'history'; c.sources[1] = 'historyFallback'
    c.startDate = '2026-01-12'; c.seedPaidHours = 40; c.seedGrowthPct = 0.3; c.holidayMismatch[1] = true
    p.capacityByQueue = { ['__proto__']: c }
    const restored = parseProject(serializeProject(p))
    expect(restored.capacityByQueue.__proto__).toEqual(c)
    expect(() => capacityConfig(restored.capacityByQueue.__proto__)).toThrow('hiringClasses[2].size')
    restored.capacityByQueue.__proto__.classes.pop()
    expect(buildCapacityPlan(capacityConfig(restored.capacityByQueue.__proto__)).weeks[12].classes).toHaveLength(2)
    p.capacityByQueue.__proto__.classes = []
    expect(parseProject(serializeProject(p)).capacityByQueue.__proto__.classes).toEqual([])
  })
  it('migrates v2 so old plans compute identically', () => {
    const plans = { ['__proto__']: v2Capacity({ weeklyAttritionPct: '10', classSize: '7.5', startWeek: '3', trainingWeeks: '1', rampWeeks: '3' }), constructor: v2Capacity({ hourlyCost: '', classSize: '' }) }
    const p = fixture()
    p.records.push({ ...p.records[0], queue: 'constructor' })
    const migrated = parseProject(JSON.stringify({ ...JSON.parse(v2Project(plans)), records: p.records }))
    expect(migrated.version).toBe(4)
    const state = migrated.capacityByQueue.__proto__
    expect(state.inputs.newHireAttritionPct).toBe('10')
    expect(state.inputs.weeklyGrowthPct).toBe('0')
    expect(state.classes).toEqual([{ size: '7.5', startWeek: '3', trainingWeeks: '1', nestingWeeks: '0', nestingProductivityPct: '0', rampWeeks: '3' }])
    expect(state.seedGrowthPct).toBeNull()
    expect(state.holidayMismatch).toEqual(Array(13).fill(false))
    // The same plan built directly with one class, equal attrition rates and no nesting.
    const expected = buildCapacityPlan({ requiredProductiveFte: [78, 78, 78, 78, 78, 78, 84, 84, 84, 84, 84, 84, 84], startingHeadcount: 100, weeklyAttrition: 0.1, newHireWeeklyAttrition: 0.1, paidHoursPerWeek: 40, shrinkage: 0.2, hourlyCost: 25,
      hiringClasses: [{ size: 7.5, startWeek: 3, trainingWeeks: 1, nestingWeeks: 0, nestingProductivity: 0, rampWeeks: 3 }] })
    expect(buildCapacityPlan(capacityConfig(state))).toEqual(expected)
    expect(expected.weeks.slice(2, 5).map(w => w.scenario.hireHeadcount)).toEqual([7.5, 6.75, 6.075])
    expect(migrated.capacityByQueue['constructor'].inputs.hourlyCost).toBe('')
    expect(migrated.capacityByQueue['constructor'].classes[0].size).toBe('')
    const example = parseProject(v2Project({ ['__proto__']: v2Capacity() })).capacityByQueue.__proto__
    expect(example).toEqual(exampleCapacityState())
    const plan = buildCapacityPlan(capacityConfig(example))
    expect([plan.baseline.firstShortageWeek, plan.scenario.firstShortageWeek, plan.incrementalCost]).toEqual([7, null, 120000])
  })
  it.each([
    ['extra v2 capacity field', () => v2Project({ ['__proto__']: { ...v2Capacity(), classes: [] } })],
    ['extra v2 input', () => v2Project({ ['__proto__']: v2Capacity({ newHireAttritionPct: '0' }) })],
    ['v3 capacity labelled v2', () => v2Project({ ['__proto__']: exampleCapacityState() })],
    ['invalid migrated value', () => v2Project({ ['__proto__']: v2Capacity({ classSize: '-1' }) })],
    ['unknown version', () => JSON.stringify({ ...fixture(), version: 5 })],
    ['missing version', () => { const { version: _v, ...rest } = fixture(); return JSON.stringify(rest) }],
  ])('rejects %s on open', (_label, text) => {
    expect(() => parseProject(text())).toThrow()
  })
  it.each([
    ['13 classes', (p: Project) => { p.capacityByQueue.__proto__.classes = Array.from({ length: 13 }, () => ({ ...p.capacityByQueue.__proto__.classes[0] })) }],
    ['extra class field', (p: Project) => { Object.assign(p.capacityByQueue.__proto__.classes[0], { id: 'a' }) }],
    ['missing class field', (p: Project) => { delete (p.capacityByQueue.__proto__.classes[0] as Partial<Record<string, string>>).nestingWeeks }],
    ['class not an object', (p: Project) => { (p.capacityByQueue.__proto__.classes as unknown[])[0] = null }],
    ['classes not an array', (p: Project) => { (p.capacityByQueue.__proto__ as unknown as Record<string, unknown>).classes = {} }],
    ['extra capacity field', (p: Project) => { Object.assign(p.capacityByQueue.__proto__, { hiringClass: {} }) }],
    ['nesting productivity', (p: Project) => { p.capacityByQueue.__proto__.classes[0].nestingProductivityPct = '101' }],
    ['fractional nesting', (p: Project) => { p.capacityByQueue.__proto__.classes[0].nestingWeeks = '0.5' }],
    ['new-hire attrition', (p: Project) => { p.capacityByQueue.__proto__.inputs.newHireAttritionPct = '-1' }],
    ['growth draft', (p: Project) => { p.capacityByQueue.__proto__.inputs.weeklyGrowthPct = '5.1' }],
    ['seed growth', (p: Project) => { p.capacityByQueue.__proto__.seedGrowthPct = -6 }],
    ['12 holiday flags', (p: Project) => { p.capacityByQueue.__proto__.holidayMismatch = Array(12).fill(false) }],
    ['non-boolean holiday flag', (p: Project) => { (p.capacityByQueue.__proto__.holidayMismatch as unknown[])[0] = 1 }],
    ['missing holiday flags', (p: Project) => { delete (p.capacityByQueue.__proto__ as Partial<CapacityState>).holidayMismatch }],
    ['old single-class input', (p: Project) => { Object.assign(p.capacityByQueue.__proto__.inputs, { classSize: '10' }) }],
  ])('rejects v3 %s', (_label, mutate) => {
    const p = fixture(); mutate(p)
    expect(() => serializeProject(p)).toThrow()
    expect(() => parseProject(JSON.stringify(p))).toThrow()
  })
})
describe('portable project validation', () => {
  it('round-trips the complete bundled sample and edited settings/provenance', () => {
    const p = fixture()
    p.records = generateSampleData()
    p.queue = p.records[0].queue
    const capacity = exampleCapacityState()
    capacity.demand[12] = '99.5'; capacity.classes[0].size = '31'
    capacity.sources[0] = 'forecast'; capacity.sources[12] = 'assumption'
    capacity.startDate = '2026-09-04'; capacity.seedPaidHours = 37.5
    p.capacityByQueue = { [p.queue]: capacity }
    p.staffing.compare = false
    p.staffing.a.fixedHeads = 123
    const restored = parseProject(serializeProject(p))
    expect(restored.records).toHaveLength(105120)
    expect(restored.records[0]).toEqual(p.records[0])
    expect(restored.records.at(-1)).toEqual(p.records.at(-1))
    expect(restored.records.reduce((sum, r) => sum + r.offered, 0)).toBe(p.records.reduce((sum, r) => sum + r.offered, 0))
    expect(restored.capacityByQueue[p.queue]).toEqual(capacity)
    expect(restored.staffing.b?.volumeDeltaPct).toBe(10)
    expect(restored.staffing.compare).toBe(false)
    expect(restored.staffing.a.fixedHeads).toBe(123)
    expect(restored.staffing.costText).toBe('27.5')
  })
  it('preserves reserved queue names as own keys and unfinished blank drafts', () => {
    const p = fixture(), c = emptyCapacityState()
    c.inputs.startingHeadcount = ''; c.inputs.paidHoursPerWeek = ' '
    p.capacityByQueue = { ['__proto__']: c }
    const result = parseProject(serializeProject(p))
    expect(Object.hasOwn(result.capacityByQueue, '__proto__')).toBe(true)
    expect(result.capacityByQueue.__proto__.inputs.startingHeadcount).toBe('')
    expect(result.capacityByQueue.__proto__.demand).toEqual(Array(13).fill(''))
  })
  it('restores a selected non-first queue and distinct plans for constructor and __proto__', () => {
    const p = fixture()
    p.records.push({ ...p.records[0], queue: 'constructor', offered: 0, aht: 0 })
    p.queue = 'constructor'
    p.capacityByQueue = { ...p.capacityByQueue, ['constructor']: emptyCapacityState() }
    const restored = parseProject(serializeProject(p))
    expect(restored.queue).toBe('constructor')
    expect(Object.keys(restored.capacityByQueue)).toEqual(['__proto__', 'constructor'])
    expect(restored.capacityByQueue['constructor'].demand[0]).toBe('')
    expect(restored.capacityByQueue.__proto__.demand[0]).toBe('78')
  })
  it.each([
    ['version', (p: Project) => { p.version = 5 as 4 }],
    ['timestamp', (p: Project) => { p.records[0].ts = '2026-02-30T08:00' }],
    ['duplicates', (p: Project) => { p.records.push({ ...p.records[0], ts: '2026-01-05T08:00:00' }) }],
    ['infinite row', (p: Project) => { p.records[0].offered = Infinity }],
    ['negative AHT', (p: Project) => { p.records[0].aht = -1 }],
    ['zero AHT', (p: Project) => { p.records[0].aht = 0 }],
    ['queue', (p: Project) => { p.queue = 'missing' }],
    ['horizon', (p: Project) => { p.horizon = 13 as 14 }],
    ['unknown capacity queue', (p: Project) => { p.capacityByQueue.nope = emptyCapacityState() }],
    ['array capacity', (p: Project) => { p.capacityByQueue = [] as unknown as Project['capacityByQueue'] }],
    ['inherited capacity', (p: Project) => { p.capacityByQueue = Object.create({ evil: emptyCapacityState() }) }],
    ['scenario range', (p: Project) => { p.staffing.a.fixedHeads = 201 }],
    ['invalid cost', (p: Project) => { p.staffing.costText = '1e999' }],
    ['missing B', (p: Project) => { p.staffing.b = null }],
    ['demand count', (p: Project) => { p.capacityByQueue.__proto__.demand.pop() }],
    ['invalid demand draft', (p: Project) => { p.capacityByQueue.__proto__.demand[0] = 'abc' }],
    ['demand range', (p: Project) => { p.capacityByQueue.__proto__.demand[0] = '1000001' }],
    ['blank cannot mask invalid config', (p: Project) => { p.capacityByQueue.__proto__.classes[0].size = ''; p.capacityByQueue.__proto__.inputs.weeklyAttritionPct = '101' }],
    ['fractional duration', (p: Project) => { p.capacityByQueue.__proto__.classes[0].trainingWeeks = '1.5' }],
    ['invalid provenance', (p: Project) => { p.capacityByQueue.__proto__.sources[0] = 'bad' as 'manual' }],
    ['invalid seed date', (p: Project) => { p.capacityByQueue.__proto__.startDate = '2026-02-29' }],
    ['invalid seed hours', (p: Project) => { p.capacityByQueue.__proto__.seedPaidHours = 0 }],
  ])('rejects %s before serializing', (_label, mutate) => {
    const p = fixture(); mutate(p)
    expect(() => validateProject(p)).toThrow()
    expect(() => serializeProject(p)).toThrow()
  })
  it('rejects JSON overflow literals and malformed JSON', () => {
    expect(() => parseProject(serializeProject(fixture()).replace('"offered":42', '"offered":1e999'))).toThrow(/finite/)
    expect(() => parseProject('{')).toThrow(/JSON/)
  })
})
