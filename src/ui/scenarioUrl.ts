/**
 * Scenario state <-> URL hash codec, so a configured what-if is shareable
 * and bookmarkable.
 *
 * Scheme (the value of the `s` hash param, e.g. `#s=v1;s:85,h:35;v:10`):
 *   v1;<scenario A fields>[;<scenario B fields>]
 * Fields are comma-joined `key:value` tokens; only values that differ from
 * DEFAULT_SCENARIO are written, so a default scenario encodes as `v1;`.
 * The third section exists only while scenario B is open. Dataset contents
 * never go in the URL.
 *
 * Decoding is forgiving per field (unknown keys are skipped, numeric values
 * are snapped to the slider's step and range) but rejects structurally
 * malformed input (wrong version, bad token shape) by returning null, so
 * callers fall back to defaults.
 */
import type { ScenarioState } from './controls/ScenarioPanel'
import { DEFAULT_SCENARIO } from './controls/ScenarioPanel'

export const SCENARIO_PARAM_VERSION = 'v1'

type NumField = {
  [K in keyof ScenarioState]: ScenarioState[K] extends number ? K : never
}[keyof ScenarioState]

interface NumSpec {
  key: string
  field: NumField
  min: number
  max: number
  step: number
}

// Ranges and steps mirror the sliders in ScenarioPanel.
const NUM_SPECS: NumSpec[] = [
  { key: 's', field: 'slPct', min: 50, max: 95, step: 1 },
  { key: 'w', field: 'slSeconds', min: 10, max: 60, step: 5 },
  { key: 'p', field: 'patienceSec', min: 30, max: 300, step: 10 },
  { key: 'x', field: 'maxAbandonPct', min: 1, max: 15, step: 1 },
  { key: 'h', field: 'shrinkagePct', min: 0, max: 50, step: 1 },
  { key: 'o', field: 'occupancyCapPct', min: 75, max: 95, step: 1 },
  { key: 'c', field: 'chatConcurrency', min: 1, max: 4, step: 1 },
  { key: 'v', field: 'volumeDeltaPct', min: -30, max: 30, step: 1 },
  { key: 't', field: 'ahtDeltaPct', min: -20, max: 20, step: 1 },
]

export function isDefaultScenario(state: ScenarioState): boolean {
  return (Object.keys(DEFAULT_SCENARIO) as (keyof ScenarioState)[]).every(
    (k) => state[k] === DEFAULT_SCENARIO[k],
  )
}

function encodeSection(state: ScenarioState): string {
  const tokens: string[] = []
  if (state.mode !== DEFAULT_SCENARIO.mode) {
    tokens.push(`m:${state.mode === 'erlangA' ? 'a' : 'c'}`)
  }
  if (state.useAbandonCap !== DEFAULT_SCENARIO.useAbandonCap) {
    tokens.push(`u:${state.useAbandonCap ? 1 : 0}`)
  }
  for (const spec of NUM_SPECS) {
    if (state[spec.field] !== DEFAULT_SCENARIO[spec.field]) {
      tokens.push(`${spec.key}:${state[spec.field]}`)
    }
  }
  return tokens.join(',')
}

/**
 * Encode scenario A (and B when open) as the `s` param value. Returns '' when
 * everything is at defaults and B is closed, meaning "no param needed".
 */
export function encodeScenarioParam(a: ScenarioState, b: ScenarioState | null): string {
  if (b === null && isDefaultScenario(a)) return ''
  const parts = [SCENARIO_PARAM_VERSION, encodeSection(a)]
  if (b !== null) parts.push(encodeSection(b))
  return parts.join(';')
}

function snap(value: number, spec: NumSpec): number {
  const stepped = spec.min + Math.round((value - spec.min) / spec.step) * spec.step
  return Math.min(spec.max, Math.max(spec.min, stepped))
}

const TOKEN_RE = /^[a-z]+:[A-Za-z0-9.-]+$/

/** One section back to a full state; null when a token is malformed. */
function decodeSection(text: string): ScenarioState | null {
  const state: ScenarioState = { ...DEFAULT_SCENARIO }
  if (text === '') return state
  for (const token of text.split(',')) {
    if (!TOKEN_RE.test(token)) return null
    const idx = token.indexOf(':')
    const key = token.slice(0, idx)
    const value = token.slice(idx + 1)
    if (key === 'm') {
      if (value === 'a') state.mode = 'erlangA'
      else if (value === 'c') state.mode = 'erlangC'
      // Any other value: keep the default silently.
      continue
    }
    if (key === 'u') {
      if (value === '1') state.useAbandonCap = true
      else if (value === '0') state.useAbandonCap = false
      continue
    }
    const spec = NUM_SPECS.find((s) => s.key === key)
    if (!spec) continue // Unknown key: skip, so future additions stay readable.
    const n = Number(value)
    if (Number.isFinite(n)) state[spec.field] = snap(n, spec)
    // Non-numeric value for a numeric key: keep the default silently.
  }
  return state
}

export interface DecodedScenarios {
  a: ScenarioState
  b: ScenarioState | null
}

/** Decode a raw `s` param value. Null for empty, unversioned, or malformed input. */
export function decodeScenarioParam(raw: string | null | undefined): DecodedScenarios | null {
  if (!raw) return null
  const parts = raw.split(';')
  if (parts[0] !== SCENARIO_PARAM_VERSION) return null
  if (parts.length < 2 || parts.length > 3) return null
  const a = decodeSection(parts[1])
  if (a === null) return null
  if (parts.length === 2) return { a, b: null }
  const b = decodeSection(parts[2])
  if (b === null) return null
  return { a, b }
}

/** Read the scenario from a location hash like "#s=v1;s:85". */
export function scenariosFromHash(hash: string): DecodedScenarios | null {
  const param = new URLSearchParams(hash.replace(/^#/, '')).get('s')
  return decodeScenarioParam(param)
}
