import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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

/**
 * A term with a toggleable plain-language definition. Renders a dotted-underline
 * button; click, Enter, Space, or tap opens the definition, Escape or an
 * outside click closes it.
 */
export function Term({ term, children }: TermProps) {
  const [open, setOpen] = useState(false)
  const [shift, setShift] = useState(0)
  const popId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  const entry = GLOSSARY[term]

  // Keep the open popover inside the viewport, including after a resize.
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const wrap = wrapRef.current
      const pop = popRef.current
      if (!wrap || !pop) return
      setShift(
        popoverShift(
          wrap.getBoundingClientRect().left,
          pop.getBoundingClientRect().width,
          document.documentElement.clientWidth,
          8,
        ),
      )
    }
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <span className="term-wrap" ref={wrapRef}>
      <button
        type="button"
        className="term-btn"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((o) => !o)}
      >
        {children ?? entry.label}
      </button>
      <span
        role="note"
        id={popId}
        className="term-pop"
        ref={popRef}
        style={{ left: shift }}
        hidden={!open}
      >
        {entry.definition}
      </span>
    </span>
  )
}
