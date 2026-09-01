import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { GLOSSARY } from './glossary'
import type { TermKey } from './glossary'

interface TermProps {
  term: TermKey
  /** Display text; defaults to the glossary label. */
  children?: ReactNode
}

/**
 * A term with a toggleable plain-language definition. Renders a dotted-underline
 * button; click, Enter, Space, or tap opens the definition, Escape or an
 * outside click closes it.
 */
export function Term({ term, children }: TermProps) {
  const [open, setOpen] = useState(false)
  const popId = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const entry = GLOSSARY[term]

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
      <span role="note" id={popId} className="term-pop" hidden={!open}>
        {entry.definition}
      </span>
    </span>
  )
}
