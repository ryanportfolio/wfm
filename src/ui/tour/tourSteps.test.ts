import { describe, expect, it } from 'vitest'
import type { TabId } from '../Tabs'
import {
  TOUR_STEPS,
  nextIndex,
  prevIndex,
  primaryLabel,
  progressLabel,
  selectorChain,
  stepBody,
} from './tourSteps'

const COUNT = TOUR_STEPS.length

// Written at the same time as the copy, and checked here so a later edit
// cannot quietly reintroduce the house style the project bans.
const BANNED =
  /delve|seamless|leverage|utilize|robust|comprehensive|crucial|pivotal|showcase|underscore|vibrant|tapestry|foster|garner|facilitate/i

// Headings and button names App.test.tsx queries by exact text. A tour title
// equal to one of these would make those queries ambiguous the moment the tour
// is open in some future test.
const RESERVED = [
  'Date range',
  'Cleaning report',
  'Load sample data',
  'Queue',
  'Go to the Data tab',
  'Data',
  'Forecast',
  'Accuracy',
  'Staffing',
]

function sentences(text: string): string[] {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0)
}

describe('TOUR_STEPS', () => {
  it('has eight steps with unique ids', () => {
    expect(COUNT).toBe(8)
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(8)
  })

  it('walks the tabs in workflow order and covers all four', () => {
    const order: TabId[] = ['data', 'forecast', 'accuracy', 'staffing']
    // Non-decreasing, not merely first-seen order: a list that went back to an
    // earlier tab would still dedupe to the four in order and pass that check.
    const seq = TOUR_STEPS.map((s) => order.indexOf(s.tab))
    expect(seq).not.toContain(-1)
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
    expect(new Set(seq).size).toBe(order.length)
  })

  it('gives every step two non-empty selectors, the first one anchored', () => {
    for (const step of TOUR_STEPS) {
      const chain = selectorChain(step)
      expect(chain).toHaveLength(2)
      for (const sel of chain) expect(sel.length).toBeGreaterThan(0)
      expect(chain[0].startsWith('[data-tour=') || chain[0].startsWith('#panel-')).toBe(true)
    }
  })

  it('keeps the copy plain, short, and free of the banned tells', () => {
    for (const step of TOUR_STEPS) {
      const texts = [step.title, step.body, ...(step.altBody ? [step.altBody] : [])]
      for (const text of texts) {
        expect(text).not.toMatch(/[—–]/)
        expect(text).not.toMatch(BANNED)
        expect(text.length).toBeLessThanOrEqual(200)
        expect(sentences(text).length).toBeLessThanOrEqual(2)
      }
    }
  })

  it('never titles a step with text the app test queries by name', () => {
    for (const step of TOUR_STEPS) expect(RESERVED).not.toContain(step.title)
  })
})

describe('step sequencing', () => {
  it('clamps at both ends', () => {
    expect(nextIndex(0, COUNT)).toBe(1)
    expect(nextIndex(COUNT - 1, COUNT)).toBe(COUNT - 1)
    expect(prevIndex(3)).toBe(2)
    expect(prevIndex(0)).toBe(0)
  })

  it('labels progress and the primary button', () => {
    expect(progressLabel(2, 8)).toBe('Step 3 of 8')
    expect(primaryLabel(0, 8)).toBe('Next')
    expect(primaryLabel(7, 8)).toBe('Done')
  })
})

describe('stepBody', () => {
  it('swaps in the alternate copy only where one exists', () => {
    const withAlt = TOUR_STEPS.filter((s) => s.altBody)
    expect(withAlt).toHaveLength(1)
    expect(withAlt[0].id).toBe('load-data')
    expect(stepBody(withAlt[0], true)).toBe(withAlt[0].altBody)
    expect(stepBody(withAlt[0], false)).toBe(withAlt[0].body)
    for (const step of TOUR_STEPS.filter((s) => !s.altBody)) {
      expect(stepBody(step, true)).toBe(step.body)
      expect(stepBody(step, false)).toBe(step.body)
    }
  })
})
