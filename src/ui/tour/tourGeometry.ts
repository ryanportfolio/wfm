/** Viewport-relative box, the shape getBoundingClientRect gives us. */
export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Grow a rect by pad on all four edges. */
export function inflateRect(rect: Rect, pad: number): Rect {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

/**
 * The part of rect that lies inside room, or null when the two do not overlap.
 * The spotlight is always a piece of the target: a card taller than the room
 * shows the piece that fits, and a target scrolled out of the room gets no
 * spotlight at all. Moving the cutout back into the room instead would draw a
 * ring around whatever unrelated content happens to be there.
 */
export function clipRect(rect: Rect, room: Rect): Rect | null {
  const left = Math.max(rect.left, room.left)
  const top = Math.max(rect.top, room.top)
  const right = Math.min(rect.left + rect.width, room.left + room.width)
  const bottom = Math.min(rect.top + rect.height, room.top + room.height)
  if (right <= left || bottom <= top) return null
  return { top, left, width: right - left, height: bottom - top }
}

/**
 * Pixels to scroll the page so rect sits inside room; positive scrolls down.
 * A target taller than the room aligns to the top of it, because the heading a
 * step talks about sits at the top of the card.
 */
export function scrollDelta(rect: Rect, room: Rect): number {
  if (rect.height >= room.height || rect.top < room.top) return rect.top - room.top
  const past = rect.top + rect.height - (room.top + room.height)
  return past > 0 ? past : 0
}

/**
 * Corner radius for the spotlight around an element: its own radius plus the
 * padding, so the cutout stays concentric with the card it covers. A pill
 * radius (the app uses 9999px) becomes a true half-height pill instead.
 */
export function holeRadius(el: Element, pad: number): number {
  const parsed = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
  if (parsed > 999) return el.getBoundingClientRect().height / 2
  return clamp(parsed + pad, 8, 28)
}

/** True when the rects are far enough apart to be worth a re-render. */
export function rectsDiffer(a: Rect | null, b: Rect | null, epsilon: number): boolean {
  if (a === null || b === null) return a !== b
  return (
    Math.abs(a.top - b.top) > epsilon ||
    Math.abs(a.left - b.left) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  )
}
