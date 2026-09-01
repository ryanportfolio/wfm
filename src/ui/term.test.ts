import { describe, expect, it } from 'vitest'
import { popoverShift } from './Term'

describe('popoverShift', () => {
  it('keeps the default position when the popover already fits', () => {
    expect(popoverShift(20, 260, 390, 8)).toBe(0)
  })

  it('shifts left just enough to clear the right margin', () => {
    // Term at 300, popover 260 wide, viewport 390: right edge would sit at
    // 560 and must come back to 382 (390 - 8).
    expect(popoverShift(300, 260, 390, 8)).toBe(-178)
  })

  it('never pushes the popover past the left margin', () => {
    // Popover as wide as the viewport allows: left edge stops at the margin
    // even though the right edge cannot fully clear.
    expect(popoverShift(4, 400, 390, 8)).toBe(4)
  })

  it('clamps a large shift at the left margin', () => {
    // Term at 10 with a popover wider than the viewport: shifting by the
    // full overflow would cross the left margin, so the clamp wins.
    expect(popoverShift(10, 380, 390, 8)).toBe(-2)
  })
})
