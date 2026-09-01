// @vitest-environment jsdom
import { StrictMode, useRef, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TabId } from '../Tabs'
import { GuidedTour } from './GuidedTour'

// The tour measures with requestAnimationFrame. A hand-driven queue lets each
// frame run inside act(), so no state update lands outside React's control.
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0

function flushFrame(): void {
  const pending = [...frames.entries()]
  frames.clear()
  for (const [, cb] of pending) cb(0)
}

beforeAll(() => {
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    frameId += 1
    frames.set(frameId, cb)
    return frameId
  }
  window.cancelAnimationFrame = (id: number) => {
    frames.delete(id)
  }
  // jsdom lays nothing out: every box is 0x0 and would read as "not ready".
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 120, left: 200, width: 300, height: 80, right: 500, bottom: 200, x: 200, y: 120 }) as DOMRect
  for (const [prop, value] of [
    ['clientWidth', 1440],
    ['clientHeight', 900],
  ] as const) {
    Object.defineProperty(document.documentElement, prop, { configurable: true, value })
  }
})

afterEach(() => {
  cleanup()
  frames.clear()
})

function Harness({
  onSelectTab,
  onClose,
  onLoadSample = () => {},
  hasData = true,
  deferOpen = false,
}: {
  onSelectTab: (tab: TabId) => void
  onClose: () => void
  onLoadSample?: () => void
  hasData?: boolean
  /** Start closed, so a test can open the tour from a focused launcher. */
  deferOpen?: boolean
}) {
  const [tab, setTab] = useState<TabId>('data')
  const [open, setOpen] = useState(!deferOpen)
  const launcherRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={launcherRef} type="button" onClick={() => setOpen(true)}>
        Tour
      </button>
      <button type="button">Elsewhere</button>
      <div data-tour="tabs">tabs</div>
      <div data-tour="load-data">load</div>
      <div data-tour="queue">queue</div>
      <div data-tour="cleaning">cleaning</div>
      <div data-tour="forecast-chart">forecast</div>
      <div id="panel-data" />
      <div id="panel-forecast" />
      {open && (
        <GuidedTour
          tab={tab}
          hasData={hasData}
          onSelectTab={(next) => {
            setTab(next)
            onSelectTab(next)
          }}
          onLoadSample={onLoadSample}
          onClose={onClose}
          launcherRef={launcherRef}
        />
      )}
    </div>
  )
}

/** The step copy on screen, as opposed to the same text in the live region. */
function visibleBody(): string {
  return document.querySelector('.tour-pop-body p')?.textContent ?? ''
}

function renderTour() {
  const onSelectTab = vi.fn()
  const onClose = vi.fn()
  render(<Harness onSelectTab={onSelectTab} onClose={onClose} />)
  act(() => flushFrame())
  return { onSelectTab, onClose }
}

describe('GuidedTour', () => {
  it('opens as a labelled dialog with focus on Next', () => {
    renderTour()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'The four steps' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  })

  it('announces the step it is on', () => {
    renderTour()
    const live = document.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toContain('Step 1 of 8.')
    expect(live?.textContent).toContain('The four steps.')
  })

  it('walks forward and back, and switches tabs when a step needs another one', () => {
    const { onSelectTab } = renderTour()
    const next = screen.getByRole('button', { name: 'Next' })
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true)

    for (let i = 0; i < 3; i++) {
      fireEvent.click(next)
      act(() => flushFrame())
    }
    expect(screen.getByText('Step 4 of 8')).toBeTruthy()
    expect(onSelectTab).not.toHaveBeenCalled()

    fireEvent.click(next)
    act(() => flushFrame())
    expect(onSelectTab).toHaveBeenCalledWith('forecast')
    expect(screen.getByRole('heading', { name: 'The forecast' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    act(() => flushFrame())
    expect(onSelectTab).toHaveBeenLastCalledWith('data')
    expect(screen.getByText('Step 4 of 8')).toBeTruthy()
  })

  it('ends on Done at the last step', () => {
    const { onClose } = renderTour()
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Next|Done/ }))
      act(() => flushFrame())
    }
    expect(screen.getByText('Step 8 of 8')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    return waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('returns focus to whatever held it at open, through a double effect pass', async () => {
    const onClose = vi.fn()
    render(<Harness deferOpen onSelectTab={vi.fn()} onClose={onClose} />, { wrapper: StrictMode })
    // StrictMode runs the open effect twice. The second pass sees focus already
    // inside the dialog, and must not overwrite what the first pass saved.
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    fireEvent.click(screen.getByRole('button', { name: 'Tour' }))
    act(() => flushFrame())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(elsewhere)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('loads the sample set when the tour opens with no data, and says so', () => {
    const onLoadSample = vi.fn()
    render(<Harness hasData={false} onLoadSample={onLoadSample} onSelectTab={vi.fn()} onClose={vi.fn()} />)
    act(() => flushFrame())
    expect(onLoadSample).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    act(() => flushFrame())
    expect(visibleBody()).toMatch(/The tour loaded two years of sample contact history/)
  })

  it('uses the alternate step-2 copy when history was already loaded', () => {
    renderTour()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    act(() => flushFrame())
    expect(visibleBody()).toMatch(/You already have history loaded/)
  })

  it('keeps focus inside the dialog when Back disables itself at step 1', () => {
    renderTour()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    act(() => flushFrame())
    const back = screen.getByRole('button', { name: 'Back' })
    back.focus()
    fireEvent.click(back)
    act(() => flushFrame())
    expect(screen.getByText('Step 1 of 8')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('steps with the arrow keys, including from a body that lost focus', () => {
    renderTour()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    act(() => flushFrame())
    expect(screen.getByText('Step 2 of 8')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
    act(() => flushFrame())
    expect(screen.getByText('Step 1 of 8')).toBeTruthy()

    document.body.focus()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    act(() => flushFrame())
    expect(screen.getByText('Step 2 of 8')).toBeTruthy()
  })

  it('cycles Tab through its own buttons and never out of the dialog', () => {
    renderTour()
    const dialog = screen.getByRole('dialog')
    // Back is disabled on step 1, so the cycle is Next then Skip tour.
    for (const name of ['Skip tour', 'Next', 'Skip tour']) {
      fireEvent.keyDown(dialog, { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByRole('button', { name }))
    }
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  })

  it('locks page scroll while it is open and gives it back on close', async () => {
    const { onClose } = renderTour()
    expect(document.documentElement.style.overflow).toBe('hidden')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    cleanup()
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('closes on Escape and hands focus back to the launcher', async () => {
    const { onClose } = renderTour()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tour' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
