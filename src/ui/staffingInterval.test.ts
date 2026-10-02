import { describe, expect, it } from 'vitest'
import { deriveIntervalSec } from './staffingInterval'

const grid = (dates: string[], times: string[]) => dates.flatMap(d => times.map(t => ({ ts: `${d}T${t}:00`, offered: 1, aht: 60 })))

describe('deriveIntervalSec', () => {
  it('reads the interval of complete grids', () => {
    const dates = ['2025-03-17', '2025-03-18']
    expect(deriveIntervalSec(grid(dates, ['08:00', '08:15', '08:30']))).toBe(900)
    expect(deriveIntervalSec(grid(dates, ['08:00', '08:30', '09:00']))).toBe(1800)
    expect(deriveIntervalSec(grid(dates, ['08:00', '09:00']))).toBe(3600)
  })

  it('uses the smallest same-day gap when a slot is absent from the first day', () => {
    const points = grid(['2025-03-17', '2025-03-18'], ['08:00', '08:30', '09:00']).filter(p => p.ts !== '2025-03-17T08:30:00')
    expect(deriveIntervalSec(points)).toBe(1800)
  })

  it('defaults to 30 minutes without two points on one day', () => {
    expect(deriveIntervalSec([])).toBe(1800)
    expect(deriveIntervalSec(grid(['2025-03-17', '2025-03-18'], ['08:00']))).toBe(1800)
  })
})
