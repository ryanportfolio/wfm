import { describe, expect, it } from 'vitest'
import { placePopover } from './tourPlacement'
import type { Rect } from './tourGeometry'

const POP = { width: 320, height: 200 }
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const OPTS = { gap: 14, margin: 12 }

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  )
}

describe('placePopover', () => {
  it('prefers below when there is room', () => {
    const hole = { top: 80, left: 500, width: 300, height: 120 }
    const out = placePopover(hole, POP, DESKTOP, OPTS)
    expect(out.side).toBe('below')
    expect(out.sheet).toBe(false)
    expect(out.top).toBe(80 + 120 + 14)
  })

  it('flips above when the target sits low', () => {
    const hole = { top: 700, left: 500, width: 300, height: 150 }
    const out = placePopover(hole, POP, DESKTOP, OPTS)
    expect(out.side).toBe('above')
    expect(out.top).toBe(700 - 14 - 200)
  })

  it('goes beside a target that fills the height', () => {
    const right = placePopover({ top: 12, left: 20, width: 300, height: 876 }, POP, DESKTOP, OPTS)
    expect(right.side).toBe('right')
    expect(right.left).toBe(20 + 300 + 14)

    const left = placePopover({ top: 12, left: 900, width: 520, height: 876 }, POP, DESKTOP, OPTS)
    expect(left.side).toBe('left')
    expect(left.left).toBe(900 - 14 - 320)
  })

  it('docks as a sheet on a phone whatever the target is doing', () => {
    for (const hole of [
      { top: 0, left: 0, width: 100, height: 40 },
      { top: 400, left: 12, width: 366, height: 200 },
      { top: 800, left: 12, width: 366, height: 40 },
    ]) {
      const out = placePopover(hole, POP, PHONE, OPTS)
      expect(out.sheet).toBe(true)
      expect(out.side).toBe('sheet')
    }
  })

  it('falls back to a sheet when no side has room', () => {
    const out = placePopover({ top: 12, left: 12, width: 1416, height: 876 }, POP, DESKTOP, OPTS)
    expect(out.sheet).toBe(true)
  })

  it('keeps a floating popover inside the margins and off the target', () => {
    const holes: Rect[] = [
      { top: 12, left: 12, width: 200, height: 60 },
      { top: 100, left: 1200, width: 220, height: 300 },
      { top: 600, left: 600, width: 400, height: 260 },
    ]
    for (const hole of holes) {
      const out = placePopover(hole, POP, DESKTOP, OPTS)
      expect(out.sheet).toBe(false)
      expect(out.left).toBeGreaterThanOrEqual(12)
      expect(out.left).toBeLessThanOrEqual(DESKTOP.width - POP.width - 12)
      expect(out.top).toBeGreaterThanOrEqual(12)
      expect(out.top).toBeLessThanOrEqual(DESKTOP.height - POP.height - 12)
      expect(overlaps({ ...POP, top: out.top, left: out.left }, hole)).toBe(false)
    }
  })
})
