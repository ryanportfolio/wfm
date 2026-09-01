import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { TabId } from '../Tabs'
import {
  TOUR_STEPS,
  nextIndex,
  prevIndex,
  primaryLabel,
  progressLabel,
  stepBody,
} from './tourSteps'
import { useTargetRect } from './useTargetRect'

/** Matches the scrim fade-out in index.css. */
const CLOSE_MS = 140
const COUNT = TOUR_STEPS.length

interface GuidedTourProps {
  /** The tab currently on screen; the tour switches it as steps demand. */
  tab: TabId
  hasData: boolean
  onSelectTab: (tab: TabId) => void
  onLoadSample: () => void
  /** Called after the scrim has faded; the parent then unmounts the tour. */
  onClose: () => void
  launcherRef: RefObject<HTMLButtonElement | null>
}

/**
 * Eight-step walkthrough of the workbench. Mounting opens it, so every open
 * starts at step 1 with fresh state. The tour switches tabs itself, spotlights
 * one element per step, and blocks the page underneath: nothing in a step asks
 * the user to press anything except the tour's own controls.
 */
export function GuidedTour({
  tab,
  hasData,
  onSelectTab,
  onLoadSample,
  onClose,
  launcherRef,
}: GuidedTourProps) {
  const [index, setIndex] = useState(0)
  const [closing, setClosing] = useState(false)
  // Captured once: step 2 says something different when history was already
  // loaded before the tour opened.
  const [hadDataAtOpen] = useState(() => hasData)
  const titleId = useId()
  const bodyId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const returnRef = useRef<HTMLElement | null>(null)
  const capturedRef = useRef(false)
  const closeTimer = useRef<number | null>(null)
  const loadedRef = useRef(false)

  const step = TOUR_STEPS[index]
  const geometry = useTargetRect(step, dialogRef, closing)

  // Focus in: the dialog is aria-modal, so landing on Next makes a screen
  // reader read the tour's name and the step body before the button itself.
  useEffect(() => {
    // Capture once, whatever else re-runs this effect. StrictMode invokes it
    // twice in development, and by the second pass focus is already on Next,
    // which would make the tour hand focus back to a button it just removed.
    if (!capturedRef.current) {
      capturedRef.current = true
      const active = document.activeElement
      // document.body means nothing held focus, in which case the launcher is
      // the honest place to put it back.
      const outside =
        active instanceof HTMLElement &&
        active !== document.body &&
        !dialogRef.current?.contains(active)
      returnRef.current = outside ? (active as HTMLElement) : null
    }
    nextRef.current?.focus()
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  // The page underneath is inert, so it must not scroll either: a wheel or a
  // swipe would slide the target out from under the spotlight while the copy
  // kept describing it. overflow: hidden stops the user, not scrollIntoView or
  // scrollBy, which is how the tour still moves the page itself. Hiding the
  // overflow also takes a classic scrollbar away, so its width is paid back as
  // padding, and nothing shifts sideways. Overlay scrollbars measure 0 and get
  // no padding.
  useEffect(() => {
    const root = document.documentElement
    const { overflow, paddingRight } = root.style
    const bar = window.innerWidth - root.clientWidth
    root.style.overflow = 'hidden'
    if (bar > 0) root.style.paddingRight = `${bar}px`
    return () => {
      root.style.overflow = overflow
      root.style.paddingRight = paddingRight
    }
  }, [])

  // With no data every step after the first would have nothing to point at, so
  // the tour loads the sample set for the user rather than asking them to.
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    if (!hadDataAtOpen) onLoadSample()
  }, [hadDataAtOpen, onLoadSample])

  // Steps span all four tabs; the tour drives the same setter a tab click does.
  useEffect(() => {
    if (step.tab !== tab) onSelectTab(step.tab)
  }, [step, tab, onSelectTab])

  const requestClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    const back = returnRef.current
    if (back?.isConnected) back.focus()
    else launcherRef.current?.focus()
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS)
  }, [closing, launcherRef, onClose])

  const goNext = useCallback(() => {
    if (index >= COUNT - 1) {
      requestClose()
      return
    }
    setIndex((i) => nextIndex(i, COUNT))
  }, [index, requestClose])

  const goBack = useCallback(() => {
    // Step 1 disables Back. Disabling the element that holds focus drops focus
    // to the body, which leaves the dialog and kills the arrow-key path, so
    // focus moves to Next first, while Back is still focusable.
    if (index <= 1) nextRef.current?.focus()
    setIndex(prevIndex)
  }, [index])

  // One window-level handler: Esc always closes, and Tab cycles inside the
  // dialog so the blocked page underneath stays unreachable by keyboard too.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
        return
      }
      const dialog = dialogRef.current
      if (!dialog) return
      // The page underneath is inert, so a key pressed with focus on the body
      // (a browser that unfocused a control the tour disabled) still belongs to
      // the tour rather than to the page.
      const inside =
        e.target === document.body || (e.target instanceof Node && dialog.contains(e.target))
      if (e.key === 'Tab') {
        const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
        if (buttons.length === 0) return
        e.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const to = e.shiftKey
          ? at <= 0
            ? buttons.length - 1
            : at - 1
          : at === buttons.length - 1 || at === -1
            ? 0
            : at + 1
        buttons[to].focus()
      } else if (inside && e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      } else if (inside && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [requestClose, goNext, goBack])

  const { rect, radius, place, measured } = geometry
  const body = stepBody(step, hadDataAtOpen)
  const popClass = [
    'tour-pop',
    place?.sheet ? 'tour-pop--sheet' : '',
    place ? '' : 'tour-pop--center',
    measured ? 'is-shown' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <>
      <div className={`tour-overlay${closing ? ' is-closing' : ''}`} aria-hidden="true">
        {/* No role and no handlers: this element exists to swallow clicks. */}
        <div className="tour-blocker" />
        {rect && (
          <div
            className="tour-hole"
            style={{
              transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
              width: rect.width,
              height: rect.height,
              borderRadius: radius,
            }}
          />
        )}
      </div>
      {!closing && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          tabIndex={-1}
          className={popClass}
          style={place && !place.sheet ? { top: place.top, left: place.left } : undefined}
        >
          <div className="tour-progress">
            <div
              className="tour-progress-bar"
              style={{ width: `${((index + 1) / COUNT) * 100}%` }}
            />
          </div>
          {/* Keyed so the copy replays its entrance; the frame around it does
              not remount, so focus inside the footer is never disturbed. */}
          <div className="tour-pop-body" key={step.id}>
            <h2 id={titleId}>{step.title}</h2>
            <p id={bodyId}>{body}</p>
          </div>
          <div className="tour-foot">
            <span className="tour-count">{progressLabel(index, COUNT)}</span>
            <span className="tour-foot-spacer" />
            <button type="button" className="btn" disabled={index === 0} onClick={goBack}>
              Back
            </button>
            <button ref={nextRef} type="button" className="btn btn-primary" onClick={goNext}>
              {primaryLabel(index, COUNT)}
            </button>
            <button type="button" className="btn btn-quiet" onClick={requestClose}>
              Skip tour
            </button>
          </div>
          {/* Inside the dialog: aria-modal="true" tells assistive tech to treat
              everything outside it as inert, a live region included. Nothing
              else announces a step, since focus stays on Next and the dialog is
              never remounted. Present at mount with its first step, which is not
              announced, so the opening step is read once, by the dialog itself. */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {`${progressLabel(index, COUNT)}. ${step.title}. ${body}`}
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
