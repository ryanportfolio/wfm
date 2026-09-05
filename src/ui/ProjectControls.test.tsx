// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { downloadTextFile } from './download'
import { emptyCapacityState } from './capacityState'
import { initialStaffing, MAX_PROJECT_BYTES, parseProject, serializeProject } from './project'
import type { Project } from './project'

vi.mock('./download', async () => ({ ...await vi.importActual('./download'), downloadTextFile: vi.fn() }))
beforeAll(() => {
  window.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/') })
function project(name = 'First project', volume = 42): Project {
  return { schema: 'wfm-project', version: 2, intradayByQueue: {}, name, records: [{ ts: '2026-01-05T08:00', queue: 'voice', offered: volume, aht: 300 }],
    sourceLabel: `${name}.csv`, queue: 'voice', horizon: 7, staffing: initialStaffing(''), capacityByQueue: { voice: emptyCapacityState() } }
}
function open(text: string | Promise<string>, size = 100) {
  fireEvent.change(screen.getByLabelText('Project JSON file'), { target: { files: [{ name: 'plan.json', size, text: () => Promise.resolve(text) }] } })
}
function edit(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function save(): Project {
  fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
  return parseProject(vi.mocked(downloadTextFile).mock.calls.at(-1)![1])
}
describe('project controls and shared settings', () => {
  it('saves and restores an inactive invalid actual after lowering the observed cutoff', async () => {
    render(<App />); open(serializeProject(project()))
    await screen.findByText('Opened project: First project')
    fireEvent.click(screen.getByRole('tab', { name: 'Intraday' }))
    await screen.findByLabelText('Actual contacts 08:00')
    edit('Observed through', '1'); edit('Actual contacts 08:00', '-1')
    edit('Observed through', '0')
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    expect(await screen.findByText('Saved project: First project')).toBeTruthy()
    const saved = parseProject(vi.mocked(downloadTextFile).mock.calls.at(-1)![1])
    expect(saved.intradayByQueue.voice.days['2026-01-06'].actuals['2026-01-06T08:00:00']).toBe('-1')
    open(serializeProject(saved))
    await screen.findByText('Opened project: First project')
    await screen.findByLabelText('Observed through')
    edit('Observed through', '1')
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).value).toBe('-1')
    await screen.findByText(/Actual contacts at 08:00 must be between/)
  })
  it('restores exact intraday inputs across days and queues and resets them on same-queue CSV replacement', async () => {
    const p = project()
    p.records.push({ ...p.records[0], queue: 'chat' })
    p.intradayByQueue = {
      voice: { selectedDay: '2026-01-06', days: { '2026-01-06': { cutoff: 1, actuals: { '2026-01-06T08:00:00': '120' }, scheduled: { '2026-01-06T08:00:00': '12.5' } } } },
      chat: { selectedDay: '2026-01-07', days: { '2026-01-07': { cutoff: 1, actuals: { '2026-01-07T08:00:00': '0' }, scheduled: { '2026-01-07T08:00:00': '5' } } } },
    }
    render(<App />); open(serializeProject(p))
    await screen.findByText('Opened project: First project')
    fireEvent.click(screen.getByRole('tab', { name: 'Intraday' }))
    await screen.findByLabelText('Actual contacts 08:00')
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).value).toBe('120')
    edit('Scheduled heads 08:00', '17')
    edit('Queue', 'chat')
    await waitFor(() => expect((screen.getByLabelText('Forecast day') as HTMLSelectElement).value).toBe('2026-01-07'))
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).value).toBe('0')
    edit('Queue', 'voice')
    await waitFor(() => expect((screen.getByLabelText('Scheduled heads 08:00') as HTMLInputElement).value).toBe('17'))
    const saved = save()
    expect(saved.intradayByQueue.chat).toEqual(p.intradayByQueue.chat)
    expect(saved.intradayByQueue.voice.days['2026-01-06'].scheduled['2026-01-06T08:00:00']).toBe('17')
    const bad = { ...saved, intradayByQueue: { orphan: p.intradayByQueue.voice } }
    open(JSON.stringify(bad)); await screen.findByText(/Intraday queue "orphan"/)
    expect(save().intradayByQueue).toEqual(saved.intradayByQueue)
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }))
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [{ name: 'replacement.csv', text: async () => 'timestamp,queue,offered,aht\n2026-01-05T08:00,voice,99,300' }] } })
    await waitFor(() => expect(save().intradayByQueue).toEqual({}))
  })
  it('saves live edits and restores all settings after same-queue replacement, ahead of the URL', async () => {
    window.history.replaceState(null, '', '/#s=v1;s:95&r=99')
    render(<App />)
    open(serializeProject(project()))
    await screen.findByText('Opened project: First project')
    fireEvent.click(screen.getByRole('tab', { name: 'Staffing' }))
    await screen.findByLabelText('Cost per scheduled hour')
    // The imported default wins over the initial 95% URL scenario.
    expect(save().staffing.a.slPct).toBe(80)
    edit('Cost per scheduled hour', '31.25')
    fireEvent.click(screen.getByRole('button', { name: 'Add comparison scenario' }))
    // Both panels have real controls; change scenario B through its range input.
    const sliders = screen.getAllByRole('slider')
    const bLast = sliders.at(-1)!
    fireEvent.change(bLast, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove scenario B' }))
    edit('Project name', 'Edited plan')
    fireEvent.click(screen.getByRole('tab', { name: 'Forecast' }))
    fireEvent.click(await screen.findByRole('button', { name: '28 days' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity' }))
    edit('Starting paid headcount', '123')
    edit('Week 1 required productive FTE', '88.5')
    const saved = save()
    expect(saved.name).toBe('Edited plan')
    expect(saved.horizon).toBe(28)
    expect(saved.staffing.costText).toBe('31.25')
    expect(saved.staffing.compare).toBe(false)
    expect(saved.staffing.b?.ahtDeltaPct).toBe(10)
    expect(saved.capacityByQueue.voice.inputs.startingHeadcount).toBe('123')
    expect(saved.capacityByQueue.voice.demand[0]).toBe('88.5')
    expect(saved.capacityByQueue.voice.sources[0]).toBe('manual')
    const replacement = project('Second project', 77)
    replacement.staffing.costText = '19'
    open(serializeProject(replacement))
    await screen.findByText('Opened project: Second project')
    expect((screen.getByLabelText('Starting paid headcount') as HTMLInputElement).value).toBe('100')
    expect(save().records[0].offered).toBe(77)
    open(serializeProject(saved))
    await screen.findByText('Opened project: Edited plan')
    expect((screen.getByLabelText('Week 1 required productive FTE') as HTMLInputElement).value).toBe('88.5')
    fireEvent.click(screen.getByRole('tab', { name: 'Staffing' }))
    await waitFor(() => expect((screen.getByLabelText('Cost per scheduled hour') as HTMLInputElement).value).toBe('31.25'))
    expect(save()).toEqual(saved)
  })
  it('keeps current data, name and invalid draft after rejected imports or saves', async () => {
    render(<App />)
    open(serializeProject(project()))
    await screen.findByText('Opened project: First project')
    const before = save()
    open('{')
    await screen.findByRole('alert')
    expect(save()).toEqual(before)
    open('{}', MAX_PROJECT_BYTES + 1)
    await screen.findByText(/64 MB/)
    expect(save()).toEqual(before)
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity' }))
    edit('Starting paid headcount', '-1')
    const count = vi.mocked(downloadTextFile).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    expect(screen.getByRole('alert').textContent).toContain('startingHeadcount')
    expect(vi.mocked(downloadTextFile).mock.calls).toHaveLength(count)
    expect((screen.getByLabelText('Starting paid headcount') as HTMLInputElement).value).toBe('-1')
  })
  it('lets the most recent import win, including rejection and CSV replacement', async () => {
    render(<App />)
    let resolveOld!: (text: string) => void
    const old = new Promise<string>(resolve => { resolveOld = resolve })
    open(old)
    open(serializeProject(project('Latest', 90)))
    await screen.findByText('Opened project: Latest')
    await act(async () => { resolveOld(serializeProject(project('Stale', 1))); await old })
    expect(save().name).toBe('Latest')
    let resolveOther!: (text: string) => void
    const other = new Promise<string>(resolve => { resolveOther = resolve })
    open(other)
    open('{')
    await screen.findByRole('alert')
    await act(async () => { resolveOther(serializeProject(project('Also stale'))); await other })
    expect(save().name).toBe('Latest')
    let resolveCsv!: (text: string) => void
    const csv = new Promise<string>(resolve => { resolveCsv = resolve })
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [{ name: 'old.csv', text: () => csv }] } })
    open(serializeProject(project('Newest', 91)))
    await screen.findByText('Opened project: Newest')
    await act(async () => { resolveCsv('timestamp,queue,offered,aht\n2026-01-05T08:00,voice,1,300'); await csv })
    expect(save().records[0].offered).toBe(91)
  })
  it('seeds original URL settings once and preserves Copy link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    window.history.replaceState(null, '', '/#s=v1;s:85;v:10&r=27.5')
    render(<App />)
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [{ name: 'history.csv', text: () => Promise.resolve('timestamp,queue,offered,aht\n2026-01-05T08:00,voice,42,300') }] } })
    await screen.findByText('Loaded: history.csv')
    fireEvent.click(screen.getByRole('tab', { name: 'Staffing' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link to this scenario' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('#s=v1;s:85;v:10&r=27.5')
    expect(save().staffing.a.slPct).toBe(85)
    expect(save().staffing.compare).toBe(true)
  })
})

it('surfaces the shared workload error and removes prior staffing exports', async () => {
  render(<App />)
  open(serializeProject(project()))
  await screen.findByText('Opened project: First project')
  fireEvent.click(screen.getByRole('tab', { name: 'Staffing' }))
  await waitFor(() => expect((screen.getByLabelText('Download interval staffing CSV, scenario A') as HTMLButtonElement).disabled).toBe(false))
  open(serializeProject(project('Oversized queue', 60000000000)))
  await screen.findByText('Opened project: Oversized queue')
  await screen.findByText(/Scenario A: Staffing supports up to 1000 Erlangs/)
  expect((screen.getByLabelText('Download interval staffing CSV, scenario A') as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByText('Peak scheduled agents')).toBeNull()
})
