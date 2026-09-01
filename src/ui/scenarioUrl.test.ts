import { describe, expect, it } from 'vitest'
import type { ScenarioState } from './controls/ScenarioPanel'
import { DEFAULT_SCENARIO } from './controls/ScenarioPanel'
import {
  decodeScenarioParam,
  encodeScenarioParam,
  isDefaultScenario,
  scenariosFromHash,
} from './scenarioUrl'

const CHANGED: ScenarioState = {
  mode: 'erlangC',
  slPct: 85,
  slSeconds: 30,
  patienceSec: 90,
  useAbandonCap: true,
  maxAbandonPct: 8,
  shrinkagePct: 35,
  occupancyCapPct: 88,
  chatConcurrency: 3,
  volumeDeltaPct: -15,
  ahtDeltaPct: 10,
}

describe('encode/decode round trip', () => {
  it('round-trips a fully changed scenario', () => {
    const param = encodeScenarioParam(CHANGED, null)
    expect(param.startsWith('v1;')).toBe(true)
    expect(decodeScenarioParam(param)).toEqual({ a: CHANGED, b: null })
  })

  it('round-trips scenario B when open', () => {
    const b: ScenarioState = { ...DEFAULT_SCENARIO, shrinkagePct: 40 }
    const decoded = decodeScenarioParam(encodeScenarioParam(CHANGED, b))
    expect(decoded).toEqual({ a: CHANGED, b })
  })

  it('round-trips an open scenario B that still equals the defaults', () => {
    const decoded = decodeScenarioParam(encodeScenarioParam(DEFAULT_SCENARIO, DEFAULT_SCENARIO))
    expect(decoded).toEqual({ a: DEFAULT_SCENARIO, b: DEFAULT_SCENARIO })
  })

  it('encodes an all-default state with no B as the empty string', () => {
    expect(encodeScenarioParam(DEFAULT_SCENARIO, null)).toBe('')
    expect(encodeScenarioParam({ ...DEFAULT_SCENARIO }, null)).toBe('')
  })

  it('omits fields at their default value', () => {
    const param = encodeScenarioParam({ ...DEFAULT_SCENARIO, slPct: 90 }, null)
    expect(param).toBe('v1;s:90')
  })
})

describe('decode rejects malformed input', () => {
  it('rejects empty, unversioned, and wrong-version params', () => {
    expect(decodeScenarioParam('')).toBeNull()
    expect(decodeScenarioParam(null)).toBeNull()
    expect(decodeScenarioParam('garbage')).toBeNull()
    expect(decodeScenarioParam('s:90')).toBeNull()
    expect(decodeScenarioParam('v2;s:90')).toBeNull()
  })

  it('rejects malformed tokens and extra sections', () => {
    expect(decodeScenarioParam('v1;s90')).toBeNull()
    expect(decodeScenarioParam('v1;s:90,:')).toBeNull()
    expect(decodeScenarioParam('v1;;;')).toBeNull()
  })

  it('silently keeps defaults for unknown keys and bad values', () => {
    expect(decodeScenarioParam('v1;zz:5')).toEqual({ a: DEFAULT_SCENARIO, b: null })
    expect(decodeScenarioParam('v1;s:abc')).toEqual({ a: DEFAULT_SCENARIO, b: null })
    expect(decodeScenarioParam('v1;m:x,u:9')).toEqual({ a: DEFAULT_SCENARIO, b: null })
  })

  it('clamps out-of-range values and snaps to the slider step', () => {
    const decoded = decodeScenarioParam('v1;s:999,v:-999,w:23')
    expect(decoded?.a.slPct).toBe(95)
    expect(decoded?.a.volumeDeltaPct).toBe(-30)
    expect(decoded?.a.slSeconds).toBe(25) // snapped to the 5 s step
  })
})

describe('scenariosFromHash', () => {
  it('reads the s param from a hash', () => {
    expect(scenariosFromHash('#s=v1;s:90')).toEqual({
      a: { ...DEFAULT_SCENARIO, slPct: 90 },
      b: null,
    })
  })

  it('returns null with no usable param', () => {
    expect(scenariosFromHash('')).toBeNull()
    expect(scenariosFromHash('#other=1')).toBeNull()
  })
})

describe('reset to defaults', () => {
  it('merging DEFAULT_SCENARIO restores every field', () => {
    // The reset button replaces the state with { ...DEFAULT_SCENARIO }.
    expect({ ...CHANGED, ...DEFAULT_SCENARIO }).toEqual(DEFAULT_SCENARIO)
    expect(isDefaultScenario({ ...DEFAULT_SCENARIO })).toBe(true)
    expect(isDefaultScenario(CHANGED)).toBe(false)
  })
})
