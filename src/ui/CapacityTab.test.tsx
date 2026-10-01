// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CapacityTab } from './CapacityTab'
import { emptyCapacityState, exampleCapacityState, capacityCsv, capacityConfig } from './capacityState'
import { buildCapacityPlan, capacitySensitivity } from '../engine/capacity'
import { buildHistorySeed } from '../engine/capacitySeed'
import { generateSampleData } from '../engine/sampleData'
import type { IntervalRecord } from '../engine/types'
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
const historySeed = vi.hoisted(() => vi.fn())
vi.mock('./workerClient', () => ({ createStaffingSession: () => staffing, historySeedInWorker: historySeed }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const theme = {} as ChartTheme
const oneDay: IntervalRecord[] = [{ ts: '2026-09-06T08:00', queue: 'voice', offered: 1, aht: 300 }]
function Harness({ forecast = null, records = oneDay, queue = 'voice' }: { forecast?: ForecastResult | null; records?: IntervalRecord[]; queue?: string }) {
  const [state, setState] = useState(emptyCapacityState)
  return <CapacityTab queue={queue} records={records} forecast={forecast} state={state} onChange={setState} theme={theme} />
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
    change('Class 1 size (heads)', '0')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('0.00')
  })
  it('allows blanks and rejects invalid hours, percentages, durations and demand without stale results', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    for (const [label, bad, good] of [['Paid hours per person per week', '0', '40'], ['Tenured weekly attrition (%)', '101', '0'], ['New-hire weekly attrition (%)', '', '0'], ['Shrinkage (%)', '-1', '20'], ['Class 1 start week', '1.5', '2'], ['Class 1 training weeks', '53', '2'], ['Class 1 nesting weeks', '0.5', '0'], ['Class 1 nesting productivity (%)', '101', '0'], ['Class 1 ramp weeks', '-1', '2'], ['Cost per paid hour', '', '25'], ['Week 1 required productive FTE', '', '78'], ['Week 2 required productive FTE', '-1', '78']]) {
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
    const row = within(screen.getByRole('region', { name: '13-week editable capacity table' })).getAllByRole('row')[1]
    expect(row.textContent).toContain('2026-09-07')
  })

  it('changes hiring timing, attrition, shrinkage and cost through the actual controls', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    change('Class 1 start week', '7')
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('Week 7')
    change('Class 1 training weeks', '0')
    change('Class 1 ramp weeks', '0')
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    change('Tenured weekly attrition (%)', '10')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('Week 2')
    change('Tenured weekly attrition (%)', '0')
    change('Shrinkage (%)', '0')
    expect(screen.getByText('Baseline first shortage').nextElementSibling?.textContent).toBe('None in 13 weeks')
    change('Cost per paid hour', '50')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('140,000.00')
  })

  it('surfaces worker failure and ignores an old queue seed after unmount', async () => {
    const forecast = { intervalForecast: [], dailyForecast: Array.from({ length: 7 }, (_, i) => ({ date: addDays('2026-09-07', i) })) } as unknown as ForecastResult
    staffing.mockRejectedValueOnce(new Error('Worker unavailable'))
    const onChange = vi.fn()
    const view = render(<CapacityTab queue="a" records={oneDay} forecast={forecast} state={emptyCapacityState()} onChange={onChange} theme={theme} />)
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

  it('adds up to 12 classes, removes them, and renders zero classes without field errors', () => {
    const view = render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    fireEvent.click(screen.getByText('Add hiring class'))
    expect(value('Class 2 size (heads)')).toBe('10')
    expect(value('Class 2 start week')).toBe('3')
    expect(screen.getByText('2 of 12 classes')).toBeTruthy()
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('230,000.00')
    fireEvent.click(screen.getByLabelText('Remove class 1'))
    expect(value('Class 1 start week')).toBe('3')
    expect(document.activeElement).toBe(screen.getByText('Add hiring class'))
    fireEvent.click(screen.getByLabelText('Remove class 1'))
    expect(screen.getByText(/No hiring classes: the proposal equals the baseline/)).toBeTruthy()
    expect(view.container.querySelectorAll('.error-text')).toHaveLength(0)
    expect(screen.queryByLabelText('Class 1 size (heads)')).toBeNull()
    expect(screen.getByText('Proposed first shortage').nextElementSibling?.textContent).toBe('Week 7')
    expect(screen.getByText('Additional paid cost').nextElementSibling?.textContent).toBe('0.00')
    fireEvent.click(screen.getByText('Add hiring class'))
    expect([value('Class 1 size (heads)'), value('Class 1 start week'), value('Class 1 nesting productivity (%)')]).toEqual(['10', '2', '50'])
    for (let i = 1; i < 12; i++) fireEvent.click(screen.getByText('Add hiring class'))
    expect(value('Class 12 start week')).toBe('13')
    expect((screen.getByText('Add hiring class') as HTMLButtonElement).disabled).toBe(true)
  })

  it('moves focus to the previous Remove button and ignores the second click of a double click', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('Add hiring class'))
    fireEvent.click(screen.getByLabelText('Remove class 3'), { detail: 1 })
    expect(document.activeElement).toBe(screen.getByLabelText('Remove class 2'))
    expect(value('Class 3 start week')).toBe('5')
    // The row below moved up under the pointer; a double click's second click must not remove it.
    fireEvent.click(screen.getByLabelText('Remove class 3'), { detail: 2 })
    expect(screen.getByText('3 of 12 classes')).toBeTruthy()
  })

  it('links invalid weekly demand to its error text', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Week 1 required productive FTE')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Enter 0 to 1,000,000.')
    change('Week 1 required productive FTE', '5')
    expect(input.getAttribute('aria-describedby')).toBeNull()
  })

  it('applies nesting weeks, nesting productivity and new-hire attrition to the proposal', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    const proposed = () => screen.getByText('Proposed first shortage').nextElementSibling?.textContent
    const production = () => within(screen.getByRole('region', { name: 'Hiring class inputs' })).getAllByRole('row')[1].children[7].textContent
    expect(production()).toBe('Week 4')
    change('Class 1 nesting weeks', '4')
    change('Class 1 nesting productivity (%)', '0')
    expect(production()).toBe('Week 8')
    expect(proposed()).toBe('Week 7')
    expect(screen.getAllByText('C1 nesting (0%)')).toHaveLength(4)
    change('Class 1 nesting productivity (%)', '100')
    expect(proposed()).toBe('None in 13 weeks')
    change('New-hire weekly attrition (%)', '20')
    expect(proposed()).toBe('Week 7')
    change('Class 1 nesting weeks', '12')
    expect(production()).toBe('After week 13')
  })

  it('seeds from the same ISO weeks of sample history through the worker client and flags holiday mismatches', async () => {
    const records = generateSampleData()
    historySeed.mockImplementation(async (r, q, start, growth) => buildHistorySeed(r, q, start, growth))
    staffing.mockImplementation(async (points, settings, options) => applyScenario(points, settings, options))
    render(<Harness records={records} queue="voice-benefits" />)
    expect(value('Plan start (Monday)')).toBe('2026-08-17')
    change('Plan start (Monday)', '2026-08-18')
    expect(screen.getByText('Choose a Monday.')).toBeTruthy()
    expect((screen.getByText('Seed demand from same week last year(s)') as HTMLButtonElement).disabled).toBe(true)
    change('Plan start (Monday)', '2026-08-17')
    change('Weekly growth (%)', '6')
    expect((screen.getByText('Seed demand from same week last year(s)') as HTMLButtonElement).disabled).toBe(true)
    change('Weekly growth (%)', '0.5')
    fireEvent.click(screen.getByText('Seed demand from same week last year(s)'))
    await waitFor(() => expect(value('Week 1 required productive FTE')).not.toBe(''), { timeout: 10_000 })
    expect(historySeed).toHaveBeenCalledWith(records, 'voice-benefits', '2026-08-17', 0.005)
    expect(staffing.mock.calls[0][2]).toMatchObject({ intervalSec: 1800, queue: 'voice-benefits' })
    expect(screen.getAllByText('History seed (same ISO week)')).toHaveLength(13)
    expect(screen.getByText(/seeded at 40 paid hours per week with 0.50% weekly growth/)).toBeTruthy()
    const rows = within(screen.getByRole('region', { name: '13-week editable capacity table' })).getAllByRole('row')
    // ISO week 36 held Labor Day in 2024 and 2025; in 2026 it falls in week 37.
    expect(rows[3].textContent).toContain('2026-08-31')
    expect(rows[3].textContent).toContain('Review: its history weeks had a federal holiday; this plan week does not.')
    expect(rows[4].textContent).toContain('Review: this plan week has a federal holiday; its history weeks do not.')
    expect(screen.getAllByText(/^Review:/)).toHaveLength(2)
    change('Week 4 required productive FTE', '50')
    expect(screen.getAllByText(/^Review:/)).toHaveLength(1)
  }, 20_000)

  it('runs one-at-a-time sensitivity on demand and marks it stale after an edit', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    expect(screen.queryByRole('region', { name: 'Sensitivity table' })).toBeNull()
    fireEvent.click(screen.getByText('Run sensitivity'))
    const expected = capacitySensitivity(capacityConfig(exampleCapacityState()))
    const rows = within(screen.getByRole('region', { name: 'Sensitivity table' })).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(8)
    expect(within(screen.getByRole('region', { name: 'Sensitivity table' })).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Lever', 'Change', 'First shortage', 'First shortage change', 'Shortage FTE-weeks', 'Shortage FTE-weeks change', '13-week paid cost', 'Cost change'])
    expect(rows.map(r => r.children[0].textContent)).toEqual(['Demand (required productive FTE)', 'Demand (required productive FTE)', 'Tenured weekly attrition', 'Tenured weekly attrition', 'Shrinkage', 'Shrinkage', 'Hiring class sizes', 'Hiring class sizes'])
    expect(rows[0].children[1].textContent).toBe('-10% every week')
    expect(rows[2].children[1].textContent).toBe('-5 points (to 0.0%, limit)')
    expect(rows[3].children[1].textContent).toBe('+5 points (to 5.0%)')
    expect(rows[0].children[3].textContent).toBe('No shortage either way')
    expect(rows[1].children[2].textContent).toBe(`Week ${expected.rows[1].scenario.firstShortageWeek}`)
    expect(rows[1].children[3].textContent).toBe('New shortage')
    expect(rows[7].children[7].textContent).toBe(`+${expected.rows[7].totalCostDelta.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    expect(screen.getByText(/Current proposal: first shortage none in 13 weeks, 0.00 shortage FTE-weeks/)).toBeTruthy()
    change('Starting paid headcount', '90')
    expect(screen.getByText(/Assumptions changed after the last run/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Sensitivity table' })).toBeNull()
    fireEvent.click(screen.getByText('Run sensitivity'))
    expect(screen.getByRole('region', { name: 'Sensitivity table' })).toBeTruthy()
  })
})
