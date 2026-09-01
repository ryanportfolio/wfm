import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { TourStep } from './tourSteps'
import { selectorChain } from './tourSteps'
import { clipRect, holeRadius, inflateRect, rectsDiffer, scrollDelta } from './tourGeometry'
import type { Rect } from './tourGeometry'
import { placePopover } from './tourPlacement'
import type { Placement } from './tourPlacement'

/** Padding between the target's edge and the spotlight cutout. */
const HOLE_PAD = 8
/** Smallest gap the spotlight keeps from a viewport edge. */
const EDGE_MARGIN = 6
/** How long a step waits for its real target before settling for the fallback. */
const FALLBACK_AFTER_MS = 2000
const PLACE_OPTS = { gap: 14, margin: 12 }
/** Re-render threshold, in px: sub-pixel jitter is not worth a React update. */
const EPSILON = 0.5
/**
 * The app's sticky header. It paints over whatever scrolls under it, so the
 * room the spotlight may use starts below it, except when the header holds the
 * target itself (the tabs and the queue picker live there).
 */
const STICKY_HEADER = '.app-header'
/** Alignment scrolls allowed per step, so a placement flip cannot loop. */
const MAX_ALIGNS = 3

export interface TourGeometry {
  /** Spotlight box, viewport coordinates. Null until something resolves. */
  rect: Rect | null
  radius: number
  /** Null while the popover has no target to sit against. */
  place: Placement | null
  /** True once the loop has run a frame, so the popover can be shown. */
  measured: boolean
}

const EMPTY: TourGeometry = { rect: null, radius: 12, place: null, measured: false }

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/**
 * A target counts as ready only when it exists and has a non-zero box. Hidden
 * panels keep their contents in the DOM behind the hidden attribute, so they
 * measure 0x0; treating that as ready would snap the spotlight to the top-left
 * corner for a frame after every tab switch.
 */
function readyEl(selector: string): HTMLElement | null {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? el : null
}

function samePlace(a: Placement | null, b: Placement | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.side === b.side &&
    a.sheet === b.sheet &&
    Math.abs(a.top - b.top) <= EPSILON &&
    Math.abs(a.left - b.left) <= EPSILON
  )
}

/**
 * The area the spotlight may use: the viewport minus its margins, minus the
 * sticky header when that covers the top, minus the bottom sheet when the
 * popover is docked there.
 */
function freeRoom(
  viewport: { width: number; height: number },
  target: HTMLElement,
  sheetTop: number | null,
): Rect {
  let top = EDGE_MARGIN
  const header = document.querySelector(STICKY_HEADER)
  if (header instanceof HTMLElement && !header.contains(target)) {
    const box = header.getBoundingClientRect()
    if (box.top <= EDGE_MARGIN && box.bottom > top) top = box.bottom + EDGE_MARGIN
  }
  const bottom = sheetTop === null ? viewport.height - EDGE_MARGIN : sheetTop - PLACE_OPTS.gap
  return {
    top,
    left: EDGE_MARGIN,
    width: Math.max(0, viewport.width - EDGE_MARGIN * 2),
    height: Math.max(0, bottom - top),
  }
}

/**
 * Measures the current step's target and the popover once per animation frame.
 * One loop on one element covers page scroll, scrolling inside a .scroll box,
 * resize, header wrapping, and Recharts re-measuring after a panel unhides, so
 * the tour needs no resize, scroll, mutation, or intersection observers.
 *
 * The primary selector is retested every frame even after the fallback takes
 * over, so a card that mounts late (the worker finishing a forecast) pulls the
 * spotlight onto itself with the same glide as any other step change.
 */
export function useTargetRect(
  step: TourStep,
  popRef: RefObject<HTMLElement | null>,
  paused: boolean,
): TourGeometry {
  const [geometry, setGeometry] = useState<TourGeometry>(EMPTY)

  useEffect(() => {
    if (paused) return
    const startedAt = performance.now()
    let frame = 0
    let last: TourGeometry | null = null
    let scrolled = false
    let sheetLocked = false
    let alignedFor: string | null = null
    let aligns = 0

    const tick = () => {
      frame = requestAnimationFrame(tick)
      const elapsed = performance.now() - startedAt
      const [primary, fallback] = selectorChain(step)
      const el = readyEl(primary) ?? (elapsed > FALLBACK_AFTER_MS ? readyEl(fallback) : null)

      if (!el) {
        // Nothing to point at yet: keep the last spotlight, but let the popover
        // render so its copy is readable no matter what the page is doing.
        setGeometry((g) => (g.measured ? g : { ...g, measured: true }))
        return
      }

      if (!scrolled) {
        scrolled = true
        // Always instant: a smooth scroll races getBoundingClientRect, and the
        // motion the user reads is the spotlight gliding, not the page. "nearest"
        // covers a target inside a .scroll box; the page itself is then aligned
        // below, once the popover's own box is known.
        el.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
        return
      }

      const viewport = {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      }
      const padded = inflateRect(toRect(el.getBoundingClientRect()), HOLE_PAD)
      const popEl = popRef.current
      const popBox = popEl ? popEl.getBoundingClientRect() : null
      const radius = holeRadius(el, HOLE_PAD)

      let room = freeRoom(viewport, el, null)
      let rect = clipRect(padded, room)
      let place =
        popBox && rect
          ? placePopover(rect, { width: popBox.width, height: popBox.height }, viewport, PLACE_OPTS)
          : null

      // A sheet is wider and shorter than a floating card, which can make a
      // side fit again on the next frame. Latching it per step stops that flip.
      if (place && sheetLocked) place = { ...place, side: 'sheet', sheet: true }
      if (place?.sheet) sheetLocked = true

      if (place?.sheet && popBox) {
        // The sheet covers the bottom of the screen, so the spotlight takes the
        // room above it rather than running underneath the card being read.
        room = freeRoom(viewport, el, popBox.top)
        rect = clipRect(padded, room)
      }

      // One alignment per placement, capped: scroll the target into the room so
      // the spotlight frames the target itself instead of a slice of it.
      const key = place ? (place.sheet ? 'sheet' : place.side) : 'none'
      if (popBox && alignedFor !== key && aligns < MAX_ALIGNS) {
        alignedFor = key
        const delta = scrollDelta(padded, room)
        if (Math.abs(delta) > 1 && typeof window.scrollBy === 'function') {
          aligns += 1
          window.scrollBy(0, delta)
          return
        }
      }

      if (
        last === null ||
        rectsDiffer(last.rect, rect, EPSILON) ||
        last.radius !== radius ||
        !samePlace(last.place, place)
      ) {
        last = { rect, radius, place, measured: true }
        setGeometry(last)
      }
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [step, popRef, paused])

  return geometry
}
