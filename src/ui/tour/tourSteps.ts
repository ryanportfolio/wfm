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
    body: 'Each tab is one part of the job: load history, forecast it, check the forecast, then staff to it. Leave any time with Skip tour or the Esc key.',
  },
  {
    id: 'load-data',
    tab: 'data',
    selector: '[data-tour="load-data"]',
    fallbackSelector: '#panel-data',
    title: 'Start with data',
    body: 'The tour loaded two years of sample contact history. Your own CSV works the same way: one row per 30-minute interval.',
    altBody:
      'You already have history loaded, so the tour uses that. Any CSV works: one row per 30-minute interval.',
  },
  {
    id: 'queue',
    tab: 'data',
    selector: '[data-tour="queue"]',
    fallbackSelector: '#panel-data',
    title: 'One queue at a time',
    body: 'Every chart and number in the app follows the queue you pick here. Switch it to see another team.',
  },
  {
    id: 'cleaning',
    tab: 'data',
    selector: '[data-tour="cleaning"]',
    fallbackSelector: '#panel-data',
    title: 'The app cleans odd days first',
    body: 'Before any model runs, the app swaps outages and one-off spikes for the usual value at that weekday and half hour. It deletes nothing and lists every change here.',
  },
  {
    id: 'forecast-chart',
    tab: 'forecast',
    selector: '[data-tour="forecast-chart"]',
    fallbackSelector: '#panel-forecast',
    title: 'The forecast',
    body: 'The line predicts contacts per day, and the shaded band covers 80% of past errors. Use 7, 14, or 28 days to change how far ahead it looks.',
  },
  {
    id: 'backtest',
    tab: 'accuracy',
    selector: '[data-tour="backtest"]',
    fallbackSelector: '#panel-accuracy',
    title: 'Check it against history',
    body: 'This card scores every method on history it never saw, once you run the accuracy test. Lower error wins, and bias says whether a method runs high or low.',
  },
  {
    id: 'scenario',
    tab: 'staffing',
    selector: '[data-tour="scenario"]',
    fallbackSelector: '#panel-staffing',
    title: 'Your staffing rules',
    body: 'Set the service target, shrinkage (paid time not spent on contacts), and how long callers wait before hanging up. Erlang A allows for people who hang up while waiting; Erlang C assumes nobody does.',
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
    body: 'Peak agents, scheduled hours, and occupancy update with every change you make. The "Copy link to this scenario" button shares the exact setup you see.',
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
