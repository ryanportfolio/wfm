import type { AnimationEvent } from 'react'
import { markTourSeen } from './tourStorage'

interface TourNudgeProps {
  onStart: () => void
  onDismiss: () => void
}

/**
 * One-time offer of the tour, shown beside the header Tour button. It takes no
 * focus and covers nothing, and showing it counts as the offer, so it never
 * appears twice on a browser that can remember that. The 900ms wait before it
 * appears is an animation delay in CSS, so the component runs no timer: the
 * animation start event fires when the delay is up, which is the first moment
 * the chip is on screen and the offer has actually been made. Marking it at
 * mount instead would burn the one offer on a visitor who left inside that
 * window. Clicking either button also marks it seen, in App.
 */
export function TourNudge({ onStart, onDismiss }: TourNudgeProps) {
  const onShown = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) markTourSeen()
  }

  return (
    <div className="tour-nudge" role="status" onAnimationStart={onShown}>
      <p className="tour-nudge-text">New here? Take the one-minute tour.</p>
      <div className="tour-nudge-row">
        <button type="button" className="btn btn-primary" onClick={onStart}>
          Start tour
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}
