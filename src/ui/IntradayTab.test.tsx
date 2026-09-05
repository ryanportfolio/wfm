// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { IntradayTab } from './IntradayTab'
import { emptyIntradayState } from './intradayState'
import type { IntradayState } from './intradayState'
import { DEFAULT_SCENARIO } from './controls/ScenarioPanel'
import { calculateIntraday } from '../engine/intraday'
import type { ForecastResult } from '../engine/forecastPipeline'
import { intradayInWorker } from './workerClient'
import { downloadTextFile } from './download'
import { useChartTheme } from './theme'
import type { ChartTheme } from './theme'

vi.mock('./workerClient', () => ({ intradayInWorker: vi.fn(async (points, inputs, config) => calculateIntraday(points, inputs, config)) }))
vi.mock('./charts/IntradayChart', () => ({ IntradayChart: () => <div>Chart placeholder</div> }))
vi.mock('./download', async () => ({ ...await vi.importActual('./download'), downloadTextFile: vi.fn() }))
beforeAll(() => { window.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList })
afterEach(() => { cleanup(); vi.clearAllMocks() })
const points = [{ ts: '2026-01-06T08:00:00', offered: 100, aht: 300 }, { ts: '2026-01-06T08:30:00', offered: 200, aht: 300 }, { ts: '2026-01-07T08:00:00', offered: 50, aht: 300 }]
const forecast = { intervalForecast: points } as ForecastResult
function Harness({ queue = 'voice', initial = emptyIntradayState() }: { queue?: string; initial?: IntradayState }) {
  const [state, change] = useState(initial)
  return <IntradayTab forecast={forecast} queue={queue} state={state} onChange={change} scenario={DEFAULT_SCENARIO} theme={useChartTheme()} />
}
function edit(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }

describe('Intraday controls', () => {
  it('starts work only while active, including after hidden scenario edits', async () => {
    const props = { forecast, queue: 'voice', state: emptyIntradayState(), onChange: vi.fn(), scenario: DEFAULT_SCENARIO, theme: {} as ChartTheme }
    const view = render(<IntradayTab {...props} active={false} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(intradayInWorker).not.toHaveBeenCalled()
    view.rerender(<IntradayTab {...props} active />)
    await screen.findByText(/Revised day: 300.0/)
    expect(intradayInWorker).toHaveBeenCalledTimes(1)
    view.rerender(<IntradayTab {...props} active={false} scenario={{ ...DEFAULT_SCENARIO, shrinkagePct: 40 }} />)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(intradayInWorker).toHaveBeenCalledTimes(1)
    view.rerender(<IntradayTab {...props} active scenario={{ ...DEFAULT_SCENARIO, shrinkagePct: 40 }} />)
    await waitFor(() => expect(intradayInWorker).toHaveBeenCalledTimes(2))
    expect(vi.mocked(intradayInWorker).mock.calls[1][2].shrinkage).toBe(.4)
  })
  it('edits observed prefix and staffing, exports matching numbers, and isolates future stored actuals', async () => {
    render(<Harness initial={{ selectedDay: '2026-01-06', days: { '2026-01-06': { cutoff: 1, actuals: { [points[0].ts]: '120', [points[1].ts]: '9000' }, scheduled: {} } } }} />)
    expect((screen.getByLabelText('Actual contacts 08:30') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Actual contacts 08:30') as HTMLInputElement).value).toBe('')
    await screen.findByText(/Revised day: 360.0/)
    edit('Scheduled heads 08:00', '30')
    expect(screen.queryByRole('button', { name: 'Export intraday CSV' })).toBeNull()
    await screen.findByText(/Revised day: 360.0/)
    fireEvent.click(screen.getByRole('button', { name: 'Export intraday CSV' }))
    const csv = vi.mocked(downloadTextFile).mock.calls[0][1]
    expect(csv).toContain('observed,100.0,120.0,30,')
    expect(csv).toContain('remaining,200.0,240.0,0,')
    edit('Actual contacts 08:00', '')
    await screen.findByRole('alert')
    expect(screen.queryByText(/Revised day:/)).toBeNull()
    edit('Actual contacts 08:00', '0')
    await screen.findByText(/Revised day: 0.0/)
  })
  it('restores per-day drafts and clears numerical outputs immediately under changed day', async () => {
    render(<Harness />)
    edit('Observed through', '1'); edit('Actual contacts 08:00', '120')
    await screen.findByText(/Revised day: 360.0/)
    edit('Forecast day', '2026-01-07')
    expect(screen.queryByText(/Revised day: 360.0/)).toBeNull()
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).disabled).toBe(true)
    await screen.findByText(/Revised day: 50.0/)
    edit('Forecast day', '2026-01-06')
    expect((screen.getByLabelText('Actual contacts 08:00') as HTMLInputElement).value).toBe('120')
    await screen.findByText(/Revised day: 360.0/)
  })
  it('recovers a worker failure through retry', async () => {
    vi.mocked(intradayInWorker).mockRejectedValueOnce(new Error('Worker unavailable'))
    render(<Harness />)
    await screen.findByText(/Worker unavailable/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry calculation' }))
    await screen.findByText(/Revised day: 300.0/)
  })
  it('rejects stale results even when the worker ignores abort', async () => {
    let finish!: (result: ReturnType<typeof calculateIntraday>) => void
    vi.mocked(intradayInWorker).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<Harness />)
    await waitFor(() => expect(finish).toBeDefined())
    const first = vi.mocked(intradayInWorker).mock.calls[0]
    edit('Forecast day', '2026-01-07')
    await screen.findByText(/Revised day: 50.0/)
    finish(calculateIntraday(first[0], first[1], first[2]))
    await waitFor(() => expect(screen.queryByText(/Revised day: 300.0/)).toBeNull())
  })
})
