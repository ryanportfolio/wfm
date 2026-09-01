// @vitest-environment jsdom
// holeRadius reads a computed style, so this file needs a DOM; the rest is pure.
import { afterEach, describe, expect, it } from 'vitest'
import { clipRect, holeRadius, inflateRect, rectsDiffer, scrollDelta } from './tourGeometry'

/** A phone viewport with its margins taken off, the shape the hook builds. */
const ROOM = { top: 6, left: 6, width: 378, height: 832 }

function stubRect(el: HTMLElement, height: number): void {
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 100, height, right: 100, bottom: height, x: 0, y: 0 }) as DOMRect
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('inflateRect', () => {
  it('pads all four edges', () => {
    expect(inflateRect({ top: 20, left: 30, width: 100, height: 40 }, 8)).toEqual({
      top: 12,
      left: 22,
      width: 116,
      height: 56,
    })
  })
})

describe('clipRect', () => {
  it('leaves a rect that already fits alone', () => {
    const rect = { top: 100, left: 40, width: 200, height: 80 }
    expect(clipRect(rect, ROOM)).toEqual(rect)
  })

  it('trims a rect wider than the room to the room', () => {
    const out = clipRect({ top: 10, left: -20, width: 600, height: 60 }, ROOM)
    expect(out).toEqual({ top: 10, left: 6, width: 378, height: 60 })
  })

  it('keeps only the part of a tall target inside the room, never moving it', () => {
    // The scenario panel at 390px: taller than the room and starting above it.
    const out = clipRect({ top: -228, left: 12, width: 366, height: 830 }, ROOM)
    expect(out).toEqual({ top: 6, left: 12, width: 366, height: 596 })
  })

  it('returns null for a target scrolled clear of the room', () => {
    expect(clipRect({ top: 900, left: 10, width: 100, height: 60 }, ROOM)).toBeNull()
    expect(clipRect({ top: -200, left: 10, width: 100, height: 60 }, ROOM)).toBeNull()
  })
})

describe('scrollDelta', () => {
  it('asks for nothing when the rect already sits inside the room', () => {
    expect(scrollDelta({ top: 100, left: 10, width: 100, height: 60 }, ROOM)).toBe(0)
  })

  it('scrolls a rect below the room up into it', () => {
    expect(scrollDelta({ top: 800, left: 10, width: 100, height: 100 }, ROOM)).toBe(62)
  })

  it('scrolls a rect above the room down into it', () => {
    expect(scrollDelta({ top: -40, left: 10, width: 100, height: 100 }, ROOM)).toBe(-46)
  })

  it('aligns a rect taller than the room to the top of it', () => {
    expect(scrollDelta({ top: 200, left: 10, width: 100, height: 1200 }, ROOM)).toBe(194)
  })
})

describe('holeRadius', () => {
  it('reads a pill as half its height', () => {
    const el = document.createElement('div')
    // The longhand, not the shorthand: jsdom does not expand border-radius.
    el.style.borderTopLeftRadius = '9999px'
    document.body.append(el)
    stubRect(el, 40)
    expect(holeRadius(el, 8)).toBe(20)
  })

  it('adds the padding to a card radius and caps it', () => {
    const el = document.createElement('div')
    el.style.borderTopLeftRadius = '16px'
    document.body.append(el)
    stubRect(el, 200)
    expect(holeRadius(el, 8)).toBe(24)
  })

  it('floors an unrounded element at 8', () => {
    const el = document.createElement('div')
    document.body.append(el)
    stubRect(el, 200)
    expect(holeRadius(el, 0)).toBe(8)
  })
})

describe('rectsDiffer', () => {
  const base = { top: 10, left: 10, width: 100, height: 50 }

  it('ignores sub-epsilon jitter', () => {
    expect(rectsDiffer(base, { ...base, top: 10.4 }, 0.5)).toBe(false)
  })

  it('reports a real move', () => {
    expect(rectsDiffer(base, { ...base, top: 11 }, 0.5)).toBe(true)
    expect(rectsDiffer(base, { ...base, width: 100.9 }, 0.5)).toBe(true)
  })

  it('treats appearing and disappearing as a difference', () => {
    expect(rectsDiffer(null, base, 0.5)).toBe(true)
    expect(rectsDiffer(base, null, 0.5)).toBe(true)
    expect(rectsDiffer(null, null, 0.5)).toBe(false)
  })
})
