// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'

// jsdom implements neither matchMedia (theme detection) nor ResizeObserver
// (Recharts ResponsiveContainer); both get inert stubs.
beforeAll(() => {
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(cleanup)

function panel(id: string): HTMLElement {
  const el = document.getElementById(`panel-${id}`)
  if (!el) throw new Error(`missing panel-${id}`)
  return el
}

describe('App smoke', () => {
  it('isolates capacity drafts by queue, preserves tab switches, and resets on dataset replacement', async () => {
    render(<App />)
    const upload = (name: string) => fireEvent.change(screen.getByLabelText('CSV file'), {
      target: { files: [{ name, text: () => Promise.resolve('timestamp,queue,offered,aht\n2026-01-05T08:00,__proto__,10,300\n2026-01-05T08:00,constructor,20,300\n') }] },
    })
    upload('first.csv')
    await screen.findByText('Loaded: first.csv')
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity' }))
    fireEvent.click(screen.getByText('Load illustrative hiring example'))
    fireEvent.change(screen.getByLabelText('Week 1 required productive FTE'), { target: { value: '91' } })
    fireEvent.change(screen.getByLabelText('Queue'), { target: { value: 'constructor' } })
    expect((screen.getByLabelText('Week 1 required productive FTE') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Starting paid headcount'), { target: { value: '33' } })
    fireEvent.change(screen.getByLabelText('Queue'), { target: { value: '__proto__' } })
    expect((screen.getByLabelText('Week 1 required productive FTE') as HTMLInputElement).value).toBe('91')
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity' }))
    expect((screen.getByLabelText('Week 1 required productive FTE') as HTMLInputElement).value).toBe('91')
    fireEvent.change(screen.getByLabelText('Queue'), { target: { value: 'constructor' } })
    expect((screen.getByLabelText('Starting paid headcount') as HTMLInputElement).value).toBe('33')
    fireEvent.click(screen.getByRole('tab', { name: 'Data' }))
    upload('second.csv')
    await screen.findByText('Loaded: second.csv')
    fireEvent.click(screen.getByRole('tab', { name: 'Capacity' }))
    expect((screen.getByLabelText('Starting paid headcount') as HTMLInputElement).value).toBe('100')
    fireEvent.change(screen.getByLabelText('Queue'), { target: { value: '__proto__' } })
    expect((screen.getByLabelText('Week 1 required productive FTE') as HTMLInputElement).value).toBe('')
  })

  it('reports all queues and preserves loaded data after an unsafe duplicate import', async () => {
    render(<App />)
    const upload = (name: string, text: string) => {
      fireEvent.change(screen.getByLabelText('CSV file'), {
        target: { files: [{ name, text: () => Promise.resolve(text) }] },
      })
    }
    upload('good.csv', 'timestamp,queue,offered,aht\n2026-01-05T08:00,a,10,300\n2026-01-07T08:00,a,0,0\n2026-01-06T09:00,b,5,300\n')
    await screen.findByText('Loaded: good.csv')
    const heading = screen.getByRole('heading', { name: 'Data completeness' })
    const table = within(heading.closest('.card')!).getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', '0', '1'])
    expect(within(rows[2]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0', '0', '0'])
    expect(screen.getByText(/Gaps may be closures or missing data/)).toBeTruthy()

    upload('duplicate.csv', 'timestamp,queue,offered,aht\n2026-01-05T08:00,x,100,300\n2026-01-05T08:00:00,x,200,300\n')
    await screen.findByText(/was rejected because it contains duplicate/)
    expect(screen.getByText('Loaded: good.csv')).toBeTruthy()
    expect([...((screen.getByLabelText('Queue') as HTMLSelectElement).options)].map((o) => o.value)).toEqual(['a', 'b'])
    expect(screen.getByText('Total contacts (a)').nextElementSibling?.textContent).toBe('10')
    expect(screen.getByText(/The file was not loaded/)).toBeTruthy()
  })

  it('renders the header, tabs, and the Data panel first', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'WFM Forecast & Staffing Workbench' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Data', 'Forecast', 'Accuracy', 'Staffing', 'Capacity', 'Intraday'])
    fireEvent.keyDown(tabs[0], { key: 'End' })
    expect(document.activeElement).toBe(tabs[5])
    expect(panel('intraday').hidden).toBe(false)
    fireEvent.keyDown(tabs[5], { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0])
    expect(panel('data').hidden).toBe(false)
    expect(panel('forecast').hidden).toBe(true)
    expect(screen.getByRole('button', { name: 'Load sample data' })).toBeTruthy()
  })

  it('switches panels on tab clicks and shows an EmptyState on data-less tabs', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: 'Forecast' }))
    expect(panel('forecast').hidden).toBe(false)
    expect(panel('data').hidden).toBe(true)
    expect(within(panel('forecast')).getByText('No data to forecast yet')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Accuracy' }))
    expect(panel('accuracy').hidden).toBe(false)
    expect(within(panel('accuracy')).getByText('No data to backtest yet')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Staffing' }))
    expect(panel('staffing').hidden).toBe(false)
    expect(within(panel('staffing')).getByText('No data to staff against yet')).toBeTruthy()

    // An EmptyState button routes back to the Data tab.
    fireEvent.click(within(panel('staffing')).getByRole('button', { name: 'Go to the Data tab' }))
    expect(panel('data').hidden).toBe(false)
  })

  it(
    'load-sample populates the Data tab and the forecast pipeline completes',
    { timeout: 30000 },
    async () => {
      render(<App />)
      fireEvent.click(screen.getByRole('button', { name: 'Load sample data' }))

      // Generation runs after a 30 ms yield; findBy polls until it lands.
      await screen.findByText(/Loaded: Sample dataset \(generated\)/, {}, { timeout: 5000 })
      const queueSelect = screen.getByLabelText('Queue') as HTMLSelectElement
      const queues = [...queueSelect.options].map((o) => o.value)
      expect(queues).toEqual(['chat-support', 'voice-benefits', 'voice-claims'])
      expect(screen.getByText('Date range')).toBeTruthy()

      // Without Worker support the forecast runs in-process (workerClient
      // fallback); the cleaning report renders once it resolves.
      await screen.findByText('Cleaning report', {}, { timeout: 25000 })
    },
  )
})

it('first rejected upload says no dataset is loaded', async () => {
  render(<App />)
  fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [{ name: 'duplicate.csv', text: () => Promise.resolve('timestamp,queue,offered,aht\n2026-01-05T08:00,q,10,300\n2026-01-05T08:00:00,q,20,300') }] } })
  expect(await screen.findByText('The file was not loaded. No dataset is loaded.')).toBeTruthy()
  expect(screen.queryByText(/Your existing data was kept/)).toBeNull()
})
