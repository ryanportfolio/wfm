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
  it('renders the header, tabs, and the Data panel first', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'WFM Forecast & Staffing Workbench' })).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Data', 'Forecast', 'Accuracy', 'Staffing'])
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
