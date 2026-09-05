// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CapacityTab } from './CapacityTab'
import { emptyCapacityState, exampleCapacityState, capacityCsv, capacityConfig } from './capacityState'
import { buildCapacityPlan } from '../engine/capacity'
import { addDays } from '../engine/series'
import type { ForecastResult } from '../engine/forecastPipeline'
import type { ChartTheme } from './theme'
import { downloadTextFile } from './download'
import { parseCsv } from '../engine/csv'
import { runForecast } from '../engine/forecastPipeline'
import { applyScenario } from '../engine/staffing'
import { DEFAULT_SCENARIO, toEngineScenario } from './controls/ScenarioPanel'

vi.mock('./charts/CapacityChart', () => ({ CapacityChart: () => <div>Capacity chart</div> }))
vi.mock('./download', () => ({ downloadTextFile: vi.fn(), fileSlug: (s: string) => s }))
const staffing = vi.hoisted(() => vi.fn())
vi.mock('./workerClient', () => ({ createStaffingSession: () => staffing }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const theme = {} as ChartTheme
function Harness({ forecast = null }: { forecast?: ForecastResult | null }) {
  const [state, setState] = useState(emptyCapacityState)
  return <CapacityTab queue="voice" forecast={forecast} state={state} onChange={setState} theme={theme} />
}
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value
const change = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } })

describe('CapacityTab', () => {
  it('seeds a 15-minute CSV using quarter-hour queue loads and paid-hour totals', async () => {
    const rows = Array.from({ length: 56 }, (_, i) => ['08:00', '08:15', '08:30', '08:45'].map(time => `${addDays('2026-01-05', i)}T${time},voice,30,300`)).flat()
    const parsed = parseCsv(['timestamp,queue,offered,aht', ...rows].join('\n'))
    expect(parsed.errors).toEqual([])
    const forecast = runForecast(parsed.records, 'voice', { horizonDays: 7 })
    const scenario = toEngineScenario(DEFAULT_SCENARIO, false)
    const config = { mode: 'erlangA' as const, slPct: .8, slSeconds: 20, patienceSec: 120, shrinkage: .3, intervalSec: 900, queue: 'voice' }
    const expected = applyScenario(forecast.intervalForecast, scenario, config).daily.reduce((sum, day) => sum + day.requiredFteHours, 0) / 40
    const wrongHalfHour = applyScenario(forecast.intervalForecast, scenario, { ...config, intervalSec: 1800 }).daily.reduce((sum, day) => sum + day.requiredFteHours, 0) / 40
    expect(expected).not.toBe(wrongHalfHour)
    staffing.mockImplementationOnce(async (points, settings, options) => applyScenario(points, settings, options))
    render(<Harness forecast={forecast} />)
    fireEvent.click(screen.getByText('Seed demand from selected forecast'))
    await waitFor(() => expect(Number(value('Week 1 required productive FTE'))).toBeCloseTo(expected, 10))
    expect(staffing.mock.calls[0][2].intervalSec).toBe(900)
  })
  it('loads the exact example, edits demand and supply, and exports matching engine rows', () => {
    render(<Harness />)
    expect(screen.getByRole('status').textContent).toContain('Blank demand is missing')
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('Week 7')
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('120,000.00')
    fireEvent.click(screen.getByText('Download capacity CSV'))
    const example = exampleCapacityState()
    expect(downloadTextFile).toHaveBeenCalledWith('capacity-voice.csv', capacityCsv(buildCapacityPlan(capacityConfig(example)), example))
    change('Week 1 required productive FTE', '90')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('Week 1')
    expect(screen.getByText('Manual assumption')).toBeTruthy()
    change('Starting paid headcount', '120')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    change('Proposed class size', '0')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('0.00')
  })
  it('allows blanks and rejects invalid hours, percentages, durations and demand without stale results', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    for (const [label, bad, good] of [['Paid hours per person per week', '0', '40'], ['Weekly attrition (%)', '101', '0'], ['Shrinkage (%)', '-1', '20'], ['Class start week', '1.5', '2'], ['Full training weeks', '53', '2'], ['Ramp weeks', '-1', '2'], ['Cost per paid hour', '', '25'], ['Week 1 required productive FTE', '', '78'], ['Week 2 required productive FTE', '-1', '78']]) {
      change(label, bad)
      expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true')
      expect(screen.queryByText('Baseline first shortage')).toBeNull()
      expect((screen.getByText('Download capacity CSV') as HTMLButtonElement).disabled).toBe(true)
      change(label, good)
      expect(screen.getByText('Baseline first shortage')).toBeTruthy()
    }
    for (let i = 1; i <= 13; i++) change(`Week ${i} required productive FTE`, '0')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
  })
  it('explicitly seeds through worker target solving and labels extrapolation and retained FTE', async () => {
    const dates = Array.from({ length: 14 }, (_, i) => addDays('2026-09-07', i))
    const forecast = { intervalForecast: [{ ts: dates[0] + 'T08:00:00', offered: 10, aht: 300 }], dailyForecast: dates.map(date => ({ date })) } as ForecastResult
    staffing.mockResolvedValue({ queue: 'voice', intervals: [], daily: dates.map(date => ({ date, requiredFteHours: 40, scheduledFteHours: 100 })) })
    render(<Harness forecast={forecast} />)
    expect(value('Week 1 required productive FTE')).toBe('')
    fireEvent.click(screen.getByText('Seed demand from selected forecast'))
    await waitFor(() => expect(value('Week 1 required productive FTE')).toBe('7'))
    expect(staffing.mock.calls[0][1]).toMatchObject({ slPct: 0.8, occupancyCap: 0.9, fixedScheduled: undefined, chatConcurrency: 1 })
    expect(screen.getAllByText('Forecast seed')).toHaveLength(2)
    expect(screen.getAllByText('Repeated week assumption')).toHaveLength(11)
    change('Paid hours per person per week', '20')
    expect(value('Week 1 required productive FTE')).toBe('7')
    expect(screen.getByText(/Demand was seeded at 40/)).toBeTruthy()
    fireEvent.click(screen.getByText('Seed demand from selected forecast'))
    await waitFor(() => expect(value('Week 1 required productive FTE')).toBe('14'))
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]
    expect(row.textContent).toContain('2026-09-07')
  })

  it('changes hiring timing, attrition, shrinkage and cost through the actual controls', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    change('Class start week', '7')
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('Week 7')
    change('Full training weeks', '0')
    change('Ramp weeks', '0')
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    change('Weekly attrition (%)', '10')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('Week 2')
    change('Weekly attrition (%)', '0')
    change('Shrinkage (%)', '0')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    change('Cost per paid hour', '50')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('140,000.00')
  })

  it('surfaces worker failure and ignores an old queue seed after unmount', async () => {
    const forecast = { intervalForecast: [], dailyForecast: Array.from({ length: 7 }, (_, i) => ({ date: addDays('2026-09-07', i) })) } as unknown as ForecastResult
    staffing.mockRejectedValueOnce(new Error('Worker unavailable'))
    const onChange = vi.fn()
    const view = render(<CapacityTab queue="a" forecast={forecast} state={emptyCapacityState()} onChange={onChange} theme={theme} />)
    fireEvent.click(screen.getByText('Seed demand from selected forecast'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Worker unavailable')
    let resolve!: (grid: unknown) => void
    staffing.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    fireEvent.click(screen.getByText('Seed demand from selected forecast'))
    view.unmount()
    resolve({ daily: [], intervals: [], queue: 'a' })
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalled()
  })
})
