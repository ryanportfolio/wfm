import { describe, expect, it } from 'vitest'
import { generateSampleData } from '../engine/sampleData'
import { emptyCapacityState, exampleCapacityState } from './capacityState'
import { initialStaffing, parseProject, serializeProject, validateProject } from './project'
import type { Project } from './project'

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
  it('migrates exact v1 fields, preserving all older settings', () => {
    const p = fixture()
    const { intradayByQueue: _intraday, ...old } = p
    expect(parseProject(JSON.stringify({ ...old, version: 1 }))).toEqual(p)
    expect(() => parseProject(JSON.stringify({ ...old, version: 1, intradayByQueue: { bad: 1 } }))).toThrow('fields')
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
  return { schema: 'wfm-project', version: 2, intradayByQueue: {}, name: 'September plan', sourceLabel: 'history.csv',
    records: [{ ts: '2026-01-05T08:00', queue: '__proto__', offered: 42, aht: 300 }],
    queue: '__proto__', horizon: 28, staffing: initialStaffing('#s=v1;s:85;v:10&r=27.50'),
    capacityByQueue: { ['__proto__']: exampleCapacityState() } }
}
describe('portable project validation', () => {
  it('round-trips the complete bundled sample and edited settings/provenance', () => {
    const p = fixture()
    p.records = generateSampleData()
    p.queue = p.records[0].queue
    const capacity = exampleCapacityState()
    capacity.demand[12] = '99.5'; capacity.inputs.classSize = '31'
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
    ['version', (p: Project) => { p.version = 3 as 2 }],
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
    ['blank cannot mask invalid config', (p: Project) => { p.capacityByQueue.__proto__.inputs.classSize = ''; p.capacityByQueue.__proto__.inputs.weeklyAttritionPct = '101' }],
    ['fractional duration', (p: Project) => { p.capacityByQueue.__proto__.inputs.trainingWeeks = '1.5' }],
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
