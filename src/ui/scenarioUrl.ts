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
 * v1 stays the version: fixed-staff mode rides in new optional per-scenario
 * keys (`g` staffing mode, `f` fixed heads) that old builds skip as unknown,
 * and the cost rate is a separate `r` hash param old builds never read, so
 * old links decode unchanged and new links degrade gracefully.
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
export const NUM_SPECS: NumSpec[] = [
  { key: 'f', field: 'fixedHeads', min: 0, max: 200, step: 1 },
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
  if (state.staffMode !== DEFAULT_SCENARIO.staffMode) {
    tokens.push(`g:${state.staffMode === 'fixed' ? 'f' : 't'}`)
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
    if (key === 'g') {
      if (value === 'f') state.staffMode = 'fixed'
      else if (value === 't') state.staffMode = 'target'
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

/**
 * Parse a raw `r` param value into a cost-per-scheduled-hour rate. Null for
 * anything unusable (missing, non-numeric, zero, negative); rounded to cents
 * and capped so a mangled link cannot produce absurd numbers.
 */
export function costRateFromParam(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(1_000_000, Math.round(n * 100) / 100)
}

export interface StaffingUrlState {
  scenarios: DecodedScenarios | null
  costPerHour: number | null
}

/**
 * Full staffing-tab hash: `s=<scenario param>` plus `r=<rate>` when a cost
 * rate is set. '' when everything is at defaults and no rate is set.
 */
export function encodeStaffingHash(
  a: ScenarioState,
  b: ScenarioState | null,
  costPerHour: number | null,
): string {
  const parts: string[] = []
  const s = encodeScenarioParam(a, b)
  if (s) parts.push(`s=${s}`)
  if (costPerHour !== null && costPerHour > 0) parts.push(`r=${costPerHour}`)
  return parts.join('&')
}

/** Read scenarios and cost rate from a location hash like "#s=v1;g:f,f:12&r=28". */
export function staffingUrlFromHash(hash: string): StaffingUrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return {
    scenarios: decodeScenarioParam(params.get('s')),
    costPerHour: costRateFromParam(params.get('r')),
  }
}
