import { describe, expect, it } from 'vitest'
import { nextTabIndex } from './Tabs'

describe('nextTabIndex', () => {
  it('moves right and wraps', () => {
    expect(nextTabIndex(0, 'ArrowRight', 5)).toBe(1)
    expect(nextTabIndex(4, 'ArrowRight', 5)).toBe(0)
  })

  it('moves left and wraps', () => {
    expect(nextTabIndex(2, 'ArrowLeft', 5)).toBe(1)
    expect(nextTabIndex(0, 'ArrowLeft', 5)).toBe(4)
  })

  it('jumps to the edges with Home and End', () => {
    expect(nextTabIndex(2, 'Home', 5)).toBe(0)
    expect(nextTabIndex(1, 'End', 5)).toBe(4)
  })

  it('ignores other keys', () => {
    expect(nextTabIndex(1, 'ArrowDown', 5)).toBeNull()
    expect(nextTabIndex(1, 'Enter', 5)).toBeNull()
    expect(nextTabIndex(1, 'a', 5)).toBeNull()
  })

  it('handles an empty tablist', () => {
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBeNull()
  })
})
