import { describe, expect, it } from 'vitest'
import { TOUR_SEEN_KEY, shouldAutoOffer } from './tourStorage'

describe('shouldAutoOffer', () => {
  it('offers the tour to a first-time visitor', () => {
    expect(shouldAutoOffer({ ok: true, value: null })).toBe(true)
  })

  it('stays quiet once the flag is stored', () => {
    expect(shouldAutoOffer({ ok: true, value: '1' })).toBe(false)
  })

  it('stays quiet when storage is unreadable, since a dismissal could not stick', () => {
    expect(shouldAutoOffer({ ok: false, value: null })).toBe(false)
  })
})

describe('TOUR_SEEN_KEY', () => {
  it('does not collide with the theme key', () => {
    expect(TOUR_SEEN_KEY).toBe('wfm-tour-seen')
  })
})
