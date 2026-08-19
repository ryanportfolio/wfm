import type { ErlangMode } from '../../engine/erlang'
import type { Scenario } from '../../engine/staffing'
import { Slider } from './Slider'
import { fmtPct, fmtSignedPct } from '../format'

/** UI slider state for one scenario. Percent fields are whole percents. */
export interface ScenarioState {
  mode: ErlangMode
  slPct: number
  slSeconds: number
  patienceSec: number
  useAbandonCap: boolean
  maxAbandonPct: number
  shrinkagePct: number
  occupancyCapPct: number
  chatConcurrency: number
  volumeDeltaPct: number
  ahtDeltaPct: number
}

export const DEFAULT_SCENARIO: ScenarioState = {
  mode: 'erlangA',
  slPct: 80,
  slSeconds: 20,
  patienceSec: 120,
  useAbandonCap: false,
  maxAbandonPct: 5,
  shrinkagePct: 30,
  occupancyCapPct: 90,
  chatConcurrency: 2,
  volumeDeltaPct: 0,
  ahtDeltaPct: 0,
}

/** Convert slider state to the engine's Scenario (fractions, chat gating). */
export function toEngineScenario(state: ScenarioState, isChatQueue: boolean): Scenario {
  return {
    volumeDeltaPct: state.volumeDeltaPct,
    ahtDeltaPct: state.ahtDeltaPct,
    mode: state.mode,
    slPct: state.slPct / 100,
    slSeconds: state.slSeconds,
    patienceSec: state.patienceSec,
    maxAbandonPct:
      state.mode === 'erlangA' && state.useAbandonCap ? state.maxAbandonPct / 100 : undefined,
    shrinkage: state.shrinkagePct / 100,
    occupancyCap: state.occupancyCapPct / 100,
    chatConcurrency: isChatQueue ? state.chatConcurrency : 1,
  }
}

interface ScenarioPanelProps {
  title: string
  state: ScenarioState
  isChatQueue: boolean
  onChange: (patch: Partial<ScenarioState>) => void
}

export function ScenarioPanel({ title, state, isChatQueue, onChange }: ScenarioPanelProps) {
  const erlangA = state.mode === 'erlangA'
  return (
    <div className="card">
      <div className="card-title">
        <h2>{title}</h2>
      </div>

      <div className="slider-row">
        <div className="slider-head">
          <span>Erlang mode</span>
        </div>
        <div className="seg">
          <button
            type="button"
            className={erlangA ? 'active' : ''}
            onClick={() => onChange({ mode: 'erlangA' })}
          >
            Erlang A
          </button>
          <button
            type="button"
            className={!erlangA ? 'active' : ''}
            onClick={() => onChange({ mode: 'erlangC' })}
          >
            Erlang C
          </button>
        </div>
        <div className="slider-hint">
          {erlangA ? 'Models caller abandonment via patience.' : 'Classic queue, no abandonment.'}
        </div>
      </div>

      <Slider
        label="Service level target"
        value={state.slPct}
        min={50}
        max={95}
        format={(v) => `${v}%`}
        onChange={(v) => onChange({ slPct: v })}
      />
      <Slider
        label="Answered within"
        value={state.slSeconds}
        min={10}
        max={60}
        step={5}
        format={(v) => `${v} s`}
        onChange={(v) => onChange({ slSeconds: v })}
      />
      <Slider
        label="Mean patience"
        value={state.patienceSec}
        min={30}
        max={300}
        step={10}
        disabled={!erlangA}
        format={(v) => `${v} s`}
        hint={erlangA ? undefined : 'Erlang A only'}
        onChange={(v) => onChange({ patienceSec: v })}
      />

      <div className="check-row">
        <input
          type="checkbox"
          id={`${title}-abandon-cap`}
          checked={state.useAbandonCap}
          disabled={!erlangA}
          onChange={(e) => onChange({ useAbandonCap: e.target.checked })}
        />
        <label htmlFor={`${title}-abandon-cap`}>Cap abandonment (Erlang A only)</label>
      </div>
      <Slider
        label="Max abandonment"
        value={state.maxAbandonPct}
        min={1}
        max={15}
        disabled={!erlangA || !state.useAbandonCap}
        format={(v) => `${v}%`}
        onChange={(v) => onChange({ maxAbandonPct: v })}
      />

      <Slider
        label="Shrinkage"
        value={state.shrinkagePct}
        min={0}
        max={50}
        format={(v) => `${v}%`}
        onChange={(v) => onChange({ shrinkagePct: v })}
      />
      <Slider
        label="Occupancy cap"
        value={state.occupancyCapPct}
        min={75}
        max={95}
        format={(v) => `${v}%`}
        onChange={(v) => onChange({ occupancyCapPct: v })}
      />
      <Slider
        label="Chat concurrency"
        value={state.chatConcurrency}
        min={1}
        max={4}
        disabled={!isChatQueue}
        format={(v) => `${v}x`}
        hint={isChatQueue ? 'Simultaneous chats per agent.' : 'Voice queue: fixed at 1.'}
        onChange={(v) => onChange({ chatConcurrency: v })}
      />
      <Slider
        label="Volume delta"
        value={state.volumeDeltaPct}
        min={-30}
        max={30}
        format={(v) => fmtSignedPct(v / 100, 0)}
        onChange={(v) => onChange({ volumeDeltaPct: v })}
      />
      <Slider
        label="AHT delta"
        value={state.ahtDeltaPct}
        min={-20}
        max={20}
        format={(v) => fmtSignedPct(v / 100, 0)}
        onChange={(v) => onChange({ ahtDeltaPct: v })}
      />
      <div className="slider-hint">
        Target: {fmtPct(state.slPct / 100, 0)} of contacts answered within {state.slSeconds} s.
      </div>
    </div>
  )
}
