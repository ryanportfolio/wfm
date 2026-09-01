import type { Rect, Size } from './tourGeometry'

export type PopoverSide = 'below' | 'above' | 'right' | 'left' | 'sheet'

export interface Placement {
  top: number
  left: number
  side: PopoverSide
  /** True when the popover docks to the bottom of the viewport full width. */
  sheet: boolean
}

export interface PlacementOptions {
  /** Distance between the spotlight edge and the popover. */
  gap: number
  /** Minimum distance from any viewport edge. */
  margin: number
}

/** Width below which a floating popover has no room to sit beside anything. */
export const SHEET_MAX_WIDTH = 620

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

/**
 * Where to put the tour popover relative to the spotlight: below, above, right,
 * or left, first one that fits. On a phone, or when no side has room, it docks
 * as a bottom sheet instead. This predicate is the only place the sheet
 * decision is made; the CSS carries the sheet's looks, never the breakpoint.
 */
export function placePopover(
  hole: Rect,
  pop: Size,
  viewport: Size,
  opts: PlacementOptions,
): Placement {
  const { gap, margin } = opts
  const sheet: Placement = { top: 0, left: 0, side: 'sheet', sheet: true }
  if (viewport.width <= SHEET_MAX_WIDTH) return sheet

  const maxLeft = viewport.width - pop.width - margin
  const maxTop = viewport.height - pop.height - margin
  const centeredLeft = clamp(hole.left + hole.width / 2 - pop.width / 2, margin, maxLeft)
  const centeredTop = clamp(hole.top + hole.height / 2 - pop.height / 2, margin, maxTop)

  const below = hole.top + hole.height + gap
  if (below + pop.height <= viewport.height - margin) {
    return { top: clamp(below, margin, maxTop), left: centeredLeft, side: 'below', sheet: false }
  }

  const above = hole.top - gap - pop.height
  if (above >= margin) {
    return { top: above, left: centeredLeft, side: 'above', sheet: false }
  }

  const right = hole.left + hole.width + gap
  if (right + pop.width <= viewport.width - margin) {
    return { top: centeredTop, left: right, side: 'right', sheet: false }
  }

  const left = hole.left - gap - pop.width
  if (left >= margin) {
    return { top: centeredTop, left, side: 'left', sheet: false }
  }

  return sheet
}
