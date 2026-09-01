import { describe, expect, it } from 'vitest'
import { nextTabIndex } from './Tabs'

describe('nextTabIndex', () => {
  it('moves right and wraps', () => {
    expect(nextTabIndex(0, 'ArrowRight', 4)).toBe(1)
    expect(nextTabIndex(3, 'ArrowRight', 4)).toBe(0)
  })

  it('moves left and wraps', () => {
    expect(nextTabIndex(2, 'ArrowLeft', 4)).toBe(1)
    expect(nextTabIndex(0, 'ArrowLeft', 4)).toBe(3)
  })

  it('jumps to the edges with Home and End', () => {
    expect(nextTabIndex(2, 'Home', 4)).toBe(0)
    expect(nextTabIndex(1, 'End', 4)).toBe(3)
  })

  it('ignores other keys', () => {
    expect(nextTabIndex(1, 'ArrowDown', 4)).toBeNull()
    expect(nextTabIndex(1, 'Enter', 4)).toBeNull()
    expect(nextTabIndex(1, 'a', 4)).toBeNull()
  })

  it('handles an empty tablist', () => {
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBeNull()
  })
})
