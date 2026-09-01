import { describe, expect, it } from 'vitest'
import { GLOSSARY } from './glossary'
import type { TermKey } from './glossary'

// Every term the acceptance gates require the UI to explain.
const REQUIRED_TERMS: TermKey[] = [
  'aht',
  'wape',
  'mape',
  'asa',
  'sl',
  'fte',
  'mad',
  'shrinkage',
  'occupancy',
  'rollingOrigin',
  'dhr',
  'erlang',
  'meanPatience',
  'abandonment',
  'offered',
  'horizonBucket',
]

describe('glossary', () => {
  it('defines every required term', () => {
    for (const key of REQUIRED_TERMS) {
      expect(GLOSSARY[key], key).toBeDefined()
    }
  })

  it('gives each entry a non-empty label and a short definition', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label.length, `${key} label`).toBeGreaterThan(0)
      expect(entry.definition.length, `${key} definition`).toBeGreaterThan(40)
      // 1-2 sentences: keep the popover readable.
      expect(entry.definition.length, `${key} definition too long`).toBeLessThan(300)
    }
  })

  it('keeps the copy free of em dashes and smart quotes', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      const text = `${entry.label} ${entry.definition}`
      expect(text, key).not.toMatch(/[—–‘’“”]/)
    }
  })
})
