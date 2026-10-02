import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { StaffingConfig } from '../engine/staffing'
import { DEFAULT_MAX_ITERATIONS, OVER_WEIGHT, PAID_WEIGHT, paidMinutes, SCHEDULE_LIMITS, slotClock, UNDER_WEIGHT, validateSchedule } from '../engine/schedule'
import type { ScheduleDayRequest } from '../engine/scheduleDay'
import { SCHEDULE_DEADLINE_MS } from '../engine/scheduleDay'
import { scheduleCoverageCsv, scheduleShiftsCsv } from '../engine/exportCsv'
import type { ScenarioState } from './controls/ScenarioPanel'
import { DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'
import type { ActivityDraft, SavedSchedule, ScheduleState, TemplateDraft } from './scheduleState'
import type { DayHours } from './scheduleState'
import { currentSchedule, defaultTemplates, describeEngineError, draftPaidTime, fmtClock, MAX_SHRINKAGE_PCT, nextTemplateId, parseTemplates, toSavedSchedule } from './scheduleState'
import { scheduleInWorker } from './workerClient'
import { errorMessage } from './errors'
import { downloadTextFile, fileSlug } from './download'
import { deriveIntervalSec } from './staffingInterval'
import { fmtDateWeekday, fmtInt, fmtNum } from './format'
import { ScheduleCoverageChart } from './charts/ScheduleCoverageChart'
import type { ChartTheme } from './theme'

interface Props {
  forecast: ForecastResult
  queue: string
  /** Scenario A from the Staffing tab: the requirement source. */
  scenario: ScenarioState
  state: ScheduleState
  onChange: (state: ScheduleState) => void
  /** Stores a finished build as the queue's saved schedule. */
  onBuilt: (built: SavedSchedule) => void
  theme: ChartTheme
}

const clockOf = (ts: string) => Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16))

export function ScheduleTab({ forecast, queue, scenario, state, onChange, onBuilt, theme }: Props) {
  const isChat = queue.toLowerCase().includes('chat')
  const dates = useMemo(() => [...new Set(forecast.intervalForecast.map(p => p.ts.slice(0, 10)))], [forecast])
  // An out-of-horizon selection stays saved so extending the horizon restores it.
  const date = state.selectedDay && dates.includes(state.selectedDay) ? state.selectedDay : dates[0] ?? ''
  const points = useMemo(() => forecast.intervalForecast.filter(p => p.ts.startsWith(date + 'T')), [forecast, date])
  const intervalSec = deriveIntervalSec(forecast.intervalForecast)
  const intervalMinutes = intervalSec / 60
  const dayStart = points[0]?.ts ?? ''
  const dayStartMinutes = dayStart ? clockOf(dayStart) : 0
  const dayMinutes = points.length * intervalMinutes
  const intervalOk = intervalMinutes === 15 || intervalMinutes === 30
  // Open hours: first to last interval with forecast contacts; the whole day when there are none.
  const hours = useMemo<DayHours>(() => {
    let first = -1
    let last = -1
    points.forEach((p, i) => { if (p.offered > 0) { if (first < 0) first = i; last = i } })
    const dayEnd = dayStartMinutes + dayMinutes
    return first < 0 ? { dayStart: dayStartMinutes, dayEnd, openStart: dayStartMinutes, openEnd: dayEnd }
      : { dayStart: dayStartMinutes, dayEnd, openStart: dayStartMinutes + first * intervalMinutes, openEnd: dayStartMinutes + (last + 1) * intervalMinutes }
  }, [points, dayStartMinutes, dayMinutes, intervalMinutes])
  // Contacts in the interval starting at 00:00 or ending at 24:00.
  const midnightContacts = points.some(p => p.offered > 0 && (clockOf(p.ts) === 0 || clockOf(p.ts) + intervalMinutes === 24 * 60))
  // Untouched defaults follow the selected day's open hours; the first edit stores concrete templates.
  const drafts = useMemo(() => state.templates ?? defaultTemplates(hours), [state.templates, hours])

  // Same base the Staffing tab uses; scenario A supplies every service setting.
  const baseConfig = useMemo<StaffingConfig>(() => ({
    mode: DEFAULT_SCENARIO.mode, slPct: DEFAULT_SCENARIO.slPct / 100, slSeconds: DEFAULT_SCENARIO.slSeconds,
    patienceSec: DEFAULT_SCENARIO.patienceSec, shrinkage: DEFAULT_SCENARIO.shrinkagePct / 100, intervalSec, queue,
  }), [intervalSec, queue])
  const engineScenario = useMemo(() => toEngineScenario(scenario, isChat), [scenario, isChat])

  const shrinkText = state.shrinkagePct.trim()
  const shrinkPct = Number(shrinkText)
  const shrinkOk = shrinkText !== '' && Number.isFinite(shrinkPct) && shrinkPct >= 0 && shrinkPct <= MAX_SHRINKAGE_PCT
  const parsed = useMemo(() => parseTemplates(drafts, dayStartMinutes, dayMinutes), [drafts, dayStartMinutes, dayMinutes])
  const engineError = useMemo(() => {
    if (!parsed.templates || !shrinkOk || points.length === 0 || !intervalOk) return null
    try {
      validateSchedule({ required: points.map(() => 0), intervalMinutes: intervalMinutes as 15 | 30, dayStart, unplannedShrinkage: shrinkPct / 100, templates: parsed.templates })
      return null
    } catch (err) {
      return describeEngineError(errorMessage(err), drafts)
    }
  }, [parsed, shrinkOk, shrinkPct, points, intervalOk, intervalMinutes, dayStart, drafts])

  const job = useMemo<ScheduleDayRequest | null>(() => parsed.templates && shrinkOk && !engineError && points.length > 0
    ? { points, scenario: engineScenario, baseConfig, unplannedShrinkage: shrinkPct / 100, templates: parsed.templates }
    : null, [parsed, shrinkOk, engineError, points, engineScenario, baseConfig, shrinkPct])

  const [failed, setFailed] = useState<{ job: ScheduleDayRequest; error: string } | null>(null)
  const [running, setRunning] = useState<ScheduleDayRequest | null>(null)
  const controller = useRef<AbortController | null>(null)
  // Changed inputs or leaving the tab for good cancels the build in flight.
  useEffect(() => () => { controller.current?.abort(); controller.current = null }, [job])
  const building = running !== null && running === job
  const liveError = failed && failed.job === job ? failed.error : null
  // A saved schedule, built here or opened from a project, shows only while the current inputs match its build.
  const result = useMemo(() => currentSchedule(state.built, job), [state.built, job])
  // Only while Build is available: invalid inputs show the fix-errors note alone.
  const stale = job !== null && !building && !result && !liveError && (state.built !== null || failed !== null)

  const build = () => {
    if (!job) return
    controller.current?.abort()
    const c = new AbortController()
    controller.current = c
    setRunning(job)
    scheduleInWorker(job, c.signal).then(r => {
      if (!c.signal.aborted) { setFailed(null); onBuilt(toSavedSchedule(job, r)); setRunning(null) }
    }).catch(err => {
      if (!c.signal.aborted) { setFailed({ job, error: errorMessage(err) }); setRunning(null) }
    })
  }
  const cancel = () => { controller.current?.abort(); controller.current = null; setRunning(null) }

  const setTemplates = (templates: TemplateDraft[]) => onChange({ ...state, selectedDay: date, templates })
  const patch = (id: string, p: Partial<TemplateDraft>) => setTemplates(drafts.map(t => t.id === id ? { ...t, ...p } : t))
  const addTemplate = () => {
    const last = drafts[drafts.length - 1]
    // Copies of copies are numbered ("Part-time 4 h copy 2"), not chained.
    const base = last.name.replace(/ copy( \d+)?$/, '')
    const taken = new Set(drafts.map(t => t.name))
    let n = 1
    while (taken.has(n === 1 ? `${base} copy` : `${base} copy ${n}`)) n++
    setTemplates([...drafts, { ...last, breaks: [...last.breaks], id: nextTemplateId(drafts), name: n === 1 ? `${base} copy` : `${base} copy ${n}` }])
  }

  if (!date) return <div className="card"><h2>Shift schedule</h2><p>No forecast intervals are available.</p></div>
  if (!intervalOk) return <div className="card"><h2>Shift schedule</h2><p role="alert">The schedule builder needs 15- or 30-minute intervals. This forecast uses {fmtNum(intervalMinutes, 0)}-minute intervals; hourly data is not supported.</p></div>

  const names = new Map(drafts.map(t => [t.id, t.name.trim()]))
  const shiftCounts = result ? drafts.map(t => ({ name: t.name.trim(), n: result.shifts.filter(s => s.templateId === t.id).length })).filter(x => x.n > 0) : []
  const clock = (slot: number) => slotClock(dayStart, slot)
  const cutShort = result !== null && result.iterations < DEFAULT_MAX_ITERATIONS
  const templatesById = new Map((job?.templates ?? []).map(t => [t.id, t]))

  return <div className="stack schedule-panel">
    <div className="card">
      <div className="card-title"><h2>Shift schedule: {queue}</h2></div>
      <p>Builds one day of shifts, with breaks and lunch placed at set times, to cover the interval requirement as closely as the shift templates allow.</p>
      <div className="schedule-controls">
        <label>Day to schedule <select value={date} onChange={e => onChange({ ...state, selectedDay: e.target.value })}>{dates.map(d => <option key={d} value={d}>{fmtDateWeekday(d)}, {d.slice(0, 4)}</option>)}</select></label>
        <label htmlFor="schedule-shrinkage">Unplanned shrinkage (%)
          <input id="schedule-shrinkage" className="num-input" type="number" min={0} max={MAX_SHRINKAGE_PCT} step="any" value={state.shrinkagePct} aria-invalid={!shrinkOk}
            aria-describedby="schedule-shrinkage-hint" onChange={e => onChange({ ...state, selectedDay: date, shrinkagePct: e.target.value })} />
        </label>
      </div>
      <p id="schedule-shrinkage-hint" className="note">Unplanned shrinkage covers absence, coaching, meetings and other off-phone time the templates do not schedule. Leave breaks and lunch out of it: they are placed explicitly. Target = required / (1 - unplanned shrinkage).</p>
      <div aria-live="polite">{!shrinkOk && <p className="error-text">Unplanned shrinkage: enter a percent from 0 to {MAX_SHRINKAGE_PCT}.</p>}</div>
      <p className="note">Required agents are scenario A's on-phone requirement from the Staffing tab: {scenario.mode === 'erlangA' ? 'Erlang A' : 'Erlang C'}, {scenario.slPct}% answered within {scenario.slSeconds} s{scenario.mode === 'erlangA' ? `, ${scenario.patienceSec} s patience` : ''}, {scenario.occupancyCapPct}% occupancy cap{scenario.mode === 'erlangA' && scenario.useAbandonCap ? `, ${scenario.maxAbandonPct}% abandonment cap` : ''}, {scenario.volumeDeltaPct}% volume and {scenario.ahtDeltaPct}% AHT adjustment{isChat ? `, ${scenario.chatConcurrency} chats per agent` : ''}. Change these in Staffing. Staffing-tab shrinkage ({scenario.shrinkagePct}%) is not used here.</p>
      <p className="note">Limits: a heuristic search for one queue and one day; it does not prove the schedule is the best possible. It has no named agents, days off, weekly hours, agent preferences, skills routing or labor-law rules. Each interval's requirement is an Erlang steady-state value, so callers still waiting at the end of an interval do not carry into the next. Times are wall-clock with no daylight-saving adjustment. Save project keeps each queue's inputs and last built schedule; an opened schedule shows while its inputs still match.</p>
    </div>

    <div className="card">
      <div className="card-title"><h2>Shift templates</h2><button type="button" className="btn" disabled={drafts.length >= SCHEDULE_LIMITS.templates} onClick={addTemplate}>Add template</button></div>
      <p className="note">Start times are clock times. Break and lunch windows are hours:minutes after the shift starts: a 1:30 to 2:30 window lets the break start 90 to 150 minutes in. All times use 15-minute steps. Breaks are paid and stay in listed order; lunch can be paid or unpaid. The minimum gap applies between activities and from the shift's start and end. Up to {SCHEDULE_LIMITS.templates} templates and {SCHEDULE_LIMITS.breaksPerTemplate} breaks each.</p>
      <p className="note">Until you edit them, default start windows follow this day's open hours, {fmtClock(hours.openStart)} to {fmtClock(hours.openEnd)} (first to last interval with forecast contacts): shifts can start at opening and end at closing. When the open hours are shorter than a shift, its window widens within the day so one shift spans them; a shift longer than the whole day is left out.</p>
      {midnightContacts && <p className="note">This day has forecast contacts at midnight. Shifts cannot cross midnight here, so the hours after 00:00 can only be covered by shifts that start at 00:00, and the hours before 24:00 by shifts that end at 24:00. Real overnight shifts that span two days are not modeled.</p>}
      <div className="schedule-templates">
        {drafts.map((d, i) => <TemplateEditor key={d.id} draft={d} index={i} canRemove={drafts.length > 1}
          errors={[...(parsed.errors.get(d.id) ?? []).map(e => ({ field: e.field, text: e.text })), ...(engineError?.templateId === d.id ? [{ field: null, text: engineError.text }] : [])]}
          onPatch={p => patch(d.id, p)} onRemove={() => setTemplates(drafts.filter(t => t.id !== d.id))} />)}
      </div>
    </div>

    <div className="card">
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!job || building} onClick={build}>{building ? 'Building schedule...' : 'Build schedule'}</button>
        {building && <button type="button" className="btn" onClick={cancel}>Cancel build</button>}
        <span role="status">{building && <><span className="spinner" /> Building shifts for {fmtDateWeekday(date)}...</>}</span>
      </div>
      <div aria-live="polite">{engineError && engineError.templateId === null && <p className="error-text">{engineError.text}</p>}</div>
      {!job && !engineError && <p className="note">Fix the errors shown above to build a schedule.</p>}
      <div role="status">{stale && <p className="note">Inputs changed since the last build. Build again to see a schedule for the current inputs.</p>}</div>
      {!state.built && !failed && !building && job && <p className="note">Same inputs always give the same schedule. Builds stop after 10 seconds.</p>}
      <div role="alert">{liveError && <p className="error-text">{liveError} No schedule was built.</p>}</div>
    </div>

    {result && <>
      <div className="cards-row schedule-summary">
        <div className="card"><div className="metric-label">Scheduled shifts</div><div className="metric-value">{fmtInt(result.totals.shiftCount)}</div>
          <div className="metric-sub">{shiftCounts.length ? shiftCounts.map(x => `${x.name}: ${x.n}`).join('; ') : 'No shift lowered the cost'}</div></div>
        <div className="card"><div className="metric-label">Paid hours (agent-hours)</div><div className="metric-value">{fmtNum(result.totals.paidAgentHours, 1)}</div>
          <div className="metric-sub">Breaks and paid lunch count; unpaid lunch does not</div></div>
        <div className="card"><div className="metric-label">Understaffing (agent-hours)</div><div className="metric-value">{fmtNum(result.totals.underAgentHours, 1)}</div>
          <div className="metric-sub">Gap below target, summed over intervals</div></div>
        <div className="card"><div className="metric-label">Overstaffing (agent-hours)</div><div className="metric-value">{fmtNum(result.totals.overAgentHours, 1)}</div>
          <div className="metric-sub">Agents above target, summed over intervals</div></div>
        <div className="card"><div className="metric-label">Cost score (lower is better)</div><div className="metric-value">{fmtNum(result.finalCost, 1)}</div>
          <div className="metric-sub">First pass {fmtNum(result.greedyCost, 1)}. Per agent per 15 minutes: {UNDER_WEIGHT} under target, {OVER_WEIGHT} over, {PAID_WEIGHT} paid</div></div>
        <div className="card"><div className="metric-label">Improvement moves tried</div><div className="metric-value">{fmtInt(result.iterations)}</div>
          <div className="metric-sub">{cutShort ? `Stopped at the ${SCHEDULE_DEADLINE_MS / 1000}-second build budget; a rerun may differ` : 'Only moves that lower the cost are kept'}</div></div>
      </div>

      <div className="card">
        <div className="card-title"><h2>Interval coverage</h2><span className="card-subtitle">{fmtDateWeekday(date)}, {date.slice(0, 4)}</span></div>
        <ScheduleCoverageChart rows={result.rows} theme={theme} />
      </div>

      <div className="card">
        <div className="card-title"><h2>Interval coverage table</h2>
          <button type="button" className="btn" onClick={() => downloadTextFile(`schedule-coverage-${fileSlug(queue)}-${date}.csv`, scheduleCoverageCsv(result.rows))}>Download coverage CSV</button></div>
        <p className="note">Agents on phones per interval. A 15-minute break removes half an agent from a 30-minute interval. Display rounds to 1 decimal; the CSV keeps up to 6.</p>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the long numeric table */}
        <div className="scroll schedule-scroll" tabIndex={0} role="region" aria-label="Interval coverage table">
          <table className="table"><caption className="sr-only">Required, target and scheduled on-phone agents by interval for {queue}, {date}</caption>
            <thead><tr><th scope="col">Interval</th><th scope="col" className="num">Required on phones</th><th scope="col" className="num">Target</th><th scope="col" className="num">Scheduled on phones</th><th scope="col" className="num">Over target</th><th scope="col" className="num">Under target</th></tr></thead>
            <tbody>{result.rows.map(r => <tr key={r.ts}><th scope="row">{r.ts.slice(11, 16)}</th><td className="num">{fmtInt(r.required)}</td><td className="num">{fmtNum(r.target, 1)}</td>
              <td className="num">{fmtNum(r.scheduled, 1)}</td><td className="num">{fmtNum(r.over, 1)}</td><td className="num">{fmtNum(r.under, 1)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title"><h2>Shift list</h2>
          <button type="button" className="btn" disabled={!job} onClick={() => job && downloadTextFile(`schedule-shifts-${fileSlug(queue)}-${date}.csv`, scheduleShiftsCsv(result, job.templates))}>Download shifts CSV</button></div>
        {result.shifts.length === 0 ? <p className="note">No shifts: no shift lowered the cost against this requirement.</p> : <>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users need to scroll the long shift list */}
          <div className="scroll schedule-scroll" tabIndex={0} role="region" aria-label="Shift list">
            <table className="table"><caption className="sr-only">Built shifts for {queue}, {date}, in start order</caption>
              <thead><tr><th scope="col" className="num">Shift</th><th scope="col">Template</th><th scope="col">Start</th><th scope="col">End</th><th scope="col">Breaks</th><th scope="col">Lunch</th><th scope="col" className="num">Paid hours</th></tr></thead>
              <tbody>{result.shifts.map((s, i) => {
                const t = templatesById.get(s.templateId)
                return <tr key={i}><td className="num">{i + 1}</td><td>{names.get(s.templateId) ?? s.templateId}</td><td>{clock(s.startSlot)}</td><td>{clock(s.endSlot)}</td>
                  <td>{s.breakSlots.map((b, j) => `${clock(b)} to ${clock(b + (t?.breaks[j].minutes ?? 15) / 15)}`).join(', ') || 'None'}</td>
                  <td>{s.lunchSlot === null || !t?.lunch ? 'None' : `${clock(s.lunchSlot)} to ${clock(s.lunchSlot + t.lunch.minutes / 15)}, ${t.lunch.paid ? 'paid' : 'unpaid'}`}</td>
                  <td className="num">{t ? fmtNum(paidMinutes(t) / 60, 2) : ''}</td></tr>
              })}</tbody>
            </table>
          </div>
        </>}
      </div>
    </>}
  </div>
}

interface EditorProps {
  draft: TemplateDraft
  index: number
  canRemove: boolean
  errors: { field: string | null; text: string }[]
  onPatch: (p: Partial<TemplateDraft>) => void
  onRemove: () => void
}

function TemplateEditor({ draft: d, index, canRemove, errors, onPatch, onRemove }: EditorProps) {
  const title = d.name.trim() || `Template ${index + 1}`
  const errorId = `sched-${d.id}-errors`
  const input = (field: string, label: string, value: string, set: (v: string) => void, placeholder?: string, fullName?: string) => {
    const id = `sched-${d.id}-${field}`
    const invalid = errors.some(e => e.field === field)
    return <label className="schedule-field" htmlFor={id}><span>{label}</span>
      <input id={id} className="num-input" value={value} placeholder={placeholder} aria-label={fullName} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={e => set(e.target.value)} />
    </label>
  }
  const activity = (prefix: string, label: string, a: ActivityDraft, set: (a: ActivityDraft) => void) => <>
    {input(`${prefix}-minutes`, 'Length (min)', a.minutes, v => set({ ...a, minutes: v }), '15', `Length (min), ${label}`)}
    {input(`${prefix}-earliest`, 'Window opens', a.earliest, v => set({ ...a, earliest: v }), '1:30', `Window opens, ${label}, h:mm after shift start`)}
    {input(`${prefix}-latest`, 'Window closes', a.latest, v => set({ ...a, latest: v }), '2:30', `Window closes, ${label}, h:mm after shift start`)}
  </>
  const paid = draftPaidTime(d)
  return <fieldset className="schedule-template">
    <legend>{title}</legend>
    <div className="schedule-grid">
      {input('name', 'Name', d.name, v => onPatch({ name: v }))}
      {input('length', 'Time on site (h:mm)', d.length, v => onPatch({ length: v }), '8:30')}
      {input('earliestStart', 'Earliest start (clock)', d.earliestStart, v => onPatch({ earliestStart: v }), '07:00')}
      {input('latestStart', 'Latest start (clock)', d.latestStart, v => onPatch({ latestStart: v }), '12:00')}
      {input('stepMinutes', 'Start every (minutes)', d.stepMinutes, v => onPatch({ stepMinutes: v }), '30')}
      {input('minGapMinutes', 'Minimum gap (minutes)', d.minGapMinutes, v => onPatch({ minGapMinutes: v }), '60')}
      {input('maxShifts', 'Max shifts (blank: no cap)', d.maxShifts, v => onPatch({ maxShifts: v }))}
    </div>
    <p className="metric-sub">Paid time per shift: {paid ?? 'n/a'}</p>
    {d.breaks.map((b, i) => <div className="schedule-activity" key={i}>
      <div className="schedule-activity-head"><span>Break {i + 1} (paid)</span>
        <button type="button" className="btn btn-quiet" onClick={() => onPatch({ breaks: d.breaks.filter((_, j) => j !== i) })}>Remove break {i + 1}</button></div>
      <div className="schedule-grid schedule-grid-3">{activity(`break-${i}`, `Break ${i + 1}`, b, next => onPatch({ breaks: d.breaks.map((x, j) => j === i ? next : x) }))}</div>
    </div>)}
    {d.lunch && <div className="schedule-activity">
      <div className="schedule-activity-head"><span>Lunch</span>
        <label className="check-row"><input type="checkbox" checked={d.lunch.paid} onChange={e => onPatch({ lunch: d.lunch && { ...d.lunch, paid: e.target.checked } })} /> Paid lunch</label>
        <button type="button" className="btn btn-quiet" onClick={() => onPatch({ lunch: null })}>Remove lunch</button></div>
      <div className="schedule-grid schedule-grid-3">{activity('lunch', 'Lunch', d.lunch, next => onPatch({ lunch: d.lunch && { ...next, paid: d.lunch.paid } }))}</div>
    </div>}
    <div className="row">
      <button type="button" className="btn" disabled={d.breaks.length >= SCHEDULE_LIMITS.breaksPerTemplate} onClick={() => onPatch({ breaks: [...d.breaks, { minutes: '15', earliest: '1:30', latest: '2:30' }] })}>Add break</button>
      {!d.lunch && <button type="button" className="btn" onClick={() => onPatch({ lunch: { minutes: '30', earliest: '3:30', latest: '5:00', paid: false } })}>Add lunch</button>}
      <button type="button" className="btn" disabled={!canRemove} onClick={onRemove}>Remove template</button>
    </div>
    <div id={errorId} className="schedule-error-region" aria-live="polite">{errors.length > 0 && <ul className="error-text schedule-errors">{errors.map((e, i) => <li key={i}>{e.text}</li>)}</ul>}</div>
  </fieldset>
}
