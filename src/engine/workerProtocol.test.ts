import { describe, expect, it, vi } from 'vitest'
import type { PendingEntry } from './workerProtocol'
import { failAll, isSuperseded, routeMessage, supersede } from './workerProtocol'

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return { resolve: vi.fn(), reject: vi.fn(), ...overrides }
}

describe('routeMessage', () => {
  it('resolves the matching entry with the result and removes it', () => {
    const pending = new Map<number, PendingEntry>()
    const e1 = entry()
    const e2 = entry()
    pending.set(1, e1)
    pending.set(2, e2)

    expect(routeMessage(pending, { id: 2, kind: 'result', result: 'grid' })).toBe(true)

    expect(e2.resolve).toHaveBeenCalledWith('grid')
    expect(e1.resolve).not.toHaveBeenCalled()
    expect(pending.has(2)).toBe(false)
    expect(pending.has(1)).toBe(true)
  })

  it('rejects the matching entry on an error message', () => {
    const pending = new Map<number, PendingEntry>()
    const e = entry()
    pending.set(7, e)

    routeMessage(pending, { id: 7, kind: 'error', message: 'boom' })

    expect(e.reject).toHaveBeenCalledTimes(1)
    const err = (e.reject as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
    expect(err.message).toBe('boom')
    expect(pending.size).toBe(0)
  })

  it('drops a response with no pending entry (stale id)', () => {
    const pending = new Map<number, PendingEntry>()
    expect(routeMessage(pending, { id: 99, kind: 'result', result: 1 })).toBe(false)
  })

  it('forwards progress without settling the entry', () => {
    const pending = new Map<number, PendingEntry>()
    const onProgress = vi.fn()
    const e = entry({ onProgress })
    pending.set(3, e)

    routeMessage(pending, { id: 3, kind: 'progress', done: 2, total: 8 })

    expect(onProgress).toHaveBeenCalledWith(2, 8)
    expect(e.resolve).not.toHaveBeenCalled()
    expect(e.reject).not.toHaveBeenCalled()
    expect(pending.has(3)).toBe(true)
  })

  it('ignores progress on an entry without a handler', () => {
    const pending = new Map<number, PendingEntry>()
    pending.set(4, entry())
    expect(routeMessage(pending, { id: 4, kind: 'progress', done: 1, total: 8 })).toBe(true)
    expect(pending.has(4)).toBe(true)
  })
})

describe('supersede', () => {
  it('removes the entry and rejects with a superseded marker', () => {
    const pending = new Map<number, PendingEntry>()
    const e = entry()
    pending.set(5, e)

    expect(supersede(pending, 5)).toBe(true)
    expect(pending.has(5)).toBe(false)
    const err = (e.reject as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
    expect(isSuperseded(err)).toBe(true)
  })

  it('later response for the superseded id is dropped', () => {
    const pending = new Map<number, PendingEntry>()
    const e = entry()
    pending.set(5, e)
    supersede(pending, 5)

    expect(routeMessage(pending, { id: 5, kind: 'result', result: 'stale grid' })).toBe(false)
    expect(e.resolve).not.toHaveBeenCalled()
  })

  it('returns false for an id that is not pending', () => {
    expect(supersede(new Map(), 1)).toBe(false)
  })
})

describe('failAll', () => {
  it('rejects every pending entry and clears the map', () => {
    const pending = new Map<number, PendingEntry>()
    const e1 = entry()
    const e2 = entry()
    pending.set(1, e1)
    pending.set(2, e2)

    failAll(pending, 'worker crashed')

    expect(pending.size).toBe(0)
    for (const e of [e1, e2]) {
      const err = (e.reject as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
      expect(err.message).toBe('worker crashed')
      expect(isSuperseded(err)).toBe(false)
    }
  })
})

describe('isSuperseded', () => {
  it('is false for ordinary errors and non-errors', () => {
    expect(isSuperseded(new Error('x'))).toBe(false)
    expect(isSuperseded('superseded')).toBe(false)
    expect(isSuperseded(null)).toBe(false)
  })
})
