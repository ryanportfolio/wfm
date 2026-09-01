import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GLOSSARY } from './glossary'
import type { TermKey } from './glossary'

interface TermProps {
  term: TermKey
  /** Display text; defaults to the glossary label. */
  children?: ReactNode
}

/**
 * Horizontal offset (px, relative to the term's left edge) that keeps a
 * popover of popWidth inside the viewport with a margin on both sides.
 * 0 means the default position (left-aligned under the term) already fits.
 * Never shifts the popover's left edge past the left margin.
 */
export function popoverShift(
  termLeft: number,
  popWidth: number,
  viewportWidth: number,
  margin: number,
): number {
  const overflowRight = termLeft + popWidth - (viewportWidth - margin)
  const shift = overflowRight > 0 ? -overflowRight : 0
  return Math.max(shift, margin - termLeft)
}

/** Gap between the term and its popover, and the viewport margin, in px. */
const POP_GAP = 6
const POP_MARGIN = 8

/**
 * A term with a toggleable plain-language definition. Renders a dotted-underline
 * button; click, Enter, Space, or tap opens the definition, Escape or an
 * outside click closes it.
 *
 * The popover renders through a portal on document.body with position: fixed,
 * so opening it never grows a scroll container (tables, .scroll boxes) and the
 * reader never has to scroll to read it.
 */
/**
 * True while the term's box shows inside the viewport and inside every scroll
 * container above it. A hidden tab panel measures 0x0 and counts as gone.
 */
function triggerVisible(btn: HTMLElement, rect: DOMRect): boolean {
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const outside = (box: { top: number; bottom: number; left: number; right: number }) =>
    rect.bottom <= box.top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right
  if (outside({ top: 0, bottom: vh, left: 0, right: vw })) return false
  for (let el = btn.parentElement; el; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el)
    if (/(auto|scroll|hidden)/.test(overflowX + overflowY) && outside(el.getBoundingClientRect())) {
      return false
    }
  }
  return true
}

export function Term({ term, children }: TermProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const popId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  const entry = GLOSSARY[term]

  // Place the popover under the term (above when there is no room below) and
  // keep it inside the viewport; follow the term on scroll and resize.
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const btn = btnRef.current
      const pop = popRef.current
      if (!btn || !pop) return
      const term = btn.getBoundingClientRect()
      // A term scrolled out of the viewport or clipped by a scroll box has
      // nothing to point at; clamping would leave the definition floating over
      // unrelated content, so it closes instead.
      if (!triggerVisible(btn, term)) {
        setOpen(false)
        return
      }
      const size = pop.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = document.documentElement.clientHeight
      const left = term.left + popoverShift(term.left, size.width, viewportWidth, POP_MARGIN)
      let top = term.bottom + POP_GAP
      if (top + size.height > viewportHeight - POP_MARGIN) top = term.top - POP_GAP - size.height
      setPos({ top: Math.max(top, POP_MARGIN), left })
    }
    reposition()
    // Capture phase so scrolls inside overflow containers reposition it too.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      const inside = btnRef.current?.contains(target) || popRef.current?.contains(target)
      if (!inside) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <span className="term-wrap">
      <button
        type="button"
        className="term-btn"
        ref={btnRef}
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? entry.label}
      </button>
      {open &&
        createPortal(
          <span
            role="note"
            id={popId}
            className="term-pop"
            ref={popRef}
            style={{ top: pos.top, left: pos.left }}
          >
            {entry.definition}
          </span>,
          document.body,
        )}
    </span>
  )
}
