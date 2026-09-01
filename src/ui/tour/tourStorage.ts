/** Own key, separate from the theme preference, so clearing one never hides the other. */
export const TOUR_SEEN_KEY = 'wfm-tour-seen'

export interface TourSeenRead {
  /** False when storage threw: private mode, blocked cookies, no storage at all. */
  ok: boolean
  value: string | null
}

export function readTourSeen(): TourSeenRead {
  try {
    return { ok: true, value: localStorage.getItem(TOUR_SEEN_KEY) }
  } catch {
    return { ok: false, value: null }
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, '1')
  } catch {
    // Storage blocked (private mode): the header Tour button still works.
  }
}

/**
 * Offer the tour unprompted only to a first-time visitor whose browser can
 * remember the dismissal. A read that throws counts as seen: with no way to
 * persist "not now", the chip would come back every load, and nagging costs
 * more than a missed offer.
 */
export function shouldAutoOffer(read: TourSeenRead): boolean {
  return read.ok && read.value === null
}
