import type { TabId } from '../Tabs'

export interface TourStep {
  id: string
  /** Tab the step needs on screen; the tour switches to it before measuring. */
  tab: TabId
  /** Preferred target. */
  selector: string
  /** Used only when the primary target is still missing or zero-sized. */
  fallbackSelector: string
  title: string
  body: string
  /** Shown instead of body when the user already had data loaded at open. */
  altBody?: string
}

const STEPS: TourStep[] = [
  {
    id: 'tabs',
    tab: 'data',
    selector: '[data-tour="tabs"]',
    fallbackSelector: '#panel-data',
    title: 'The four steps',
    body: 'One tab per step: load history, forecast, check, staff. Skip tour or Esc exits anytime.',
  },
  {
    id: 'load-data',
    tab: 'data',
    selector: '[data-tour="load-data"]',
    fallbackSelector: '#panel-data',
    title: 'Start with data',
    body: 'The tour loaded two years of sample contact history. Any CSV works: one row per 30-minute interval.',
    altBody:
      'You already have history loaded; the tour uses it. Any CSV works: one row per 30-minute interval.',
  },
  {
    id: 'queue',
    tab: 'data',
    selector: '[data-tour="queue"]',
    fallbackSelector: '#panel-data',
    title: 'One queue at a time',
    body: 'Every chart and number follows this queue; switch for another team.',
  },
  {
    id: 'cleaning',
    tab: 'data',
    selector: '[data-tour="cleaning"]',
    fallbackSelector: '#panel-data',
    title: 'Odd days cleaned',
    body: 'Outages and one-off spikes take that weekday and half hour\'s usual value. Nothing is deleted; every change is listed here.',
  },
  {
    id: 'forecast-chart',
    tab: 'forecast',
    selector: '[data-tour="forecast-chart"]',
    fallbackSelector: '#panel-forecast',
    title: 'The forecast',
    body: 'The line predicts daily contacts; the band covers 80% of past errors. Look 7, 14, or 28 days ahead.',
  },
  {
    id: 'backtest',
    tab: 'accuracy',
    selector: '[data-tour="backtest"]',
    fallbackSelector: '#panel-accuracy',
    title: 'Check against history',
    body: 'Run the accuracy test to score each method on unseen history. Lower error wins; bias shows whether a method runs high or low.',
  },
  {
    id: 'scenario',
    tab: 'staffing',
    selector: '[data-tour="scenario"]',
    fallbackSelector: '#panel-staffing',
    title: 'Your staffing rules',
    body: 'Set service target, shrinkage (paid time not on contacts), and caller patience (wait before hanging up). Erlang A counts hang-ups; Erlang C assumes none.',
  },
  {
    id: 'staffing-results',
    tab: 'staffing',
    // Fallback is the panel itself: while the forecast worker is still
    // computing, StaffingTab is replaced by the computing card, so nothing
    // inside it exists to fall back to.
    selector: '[data-tour="staffing-results"]',
    fallbackSelector: '#panel-staffing',
    title: 'What it costs',
    body: 'Peak agents, scheduled hours, and occupancy update on every change; "Copy link to this scenario" shares that setup.',
  },
]

/**
 * The tour, in workflow order: load history, forecast it, check the forecast,
 * staff to it. Copy is written to stand alone, so a step still makes sense to a
 * screen reader that never sees the highlight.
 */
export const TOUR_STEPS: readonly TourStep[] = STEPS.map((s) => Object.freeze(s))

/** Selectors to try, in order. Nothing outside this pair is ever resolved. */
export function selectorChain(step: TourStep): string[] {
  return [step.selector, step.fallbackSelector]
}

export function nextIndex(index: number, count: number): number {
  return Math.min(index + 1, count - 1)
}

export function prevIndex(index: number): number {
  return Math.max(index - 1, 0)
}

export function progressLabel(index: number, count: number): string {
  return `Step ${index + 1} of ${count}`
}

/** The last step ends the tour, so its primary button says so. */
export function primaryLabel(index: number, count: number): string {
  return index >= count - 1 ? 'Done' : 'Next'
}

export function stepBody(step: TourStep, hadData: boolean): string {
  return hadData && step.altBody ? step.altBody : step.body
}
