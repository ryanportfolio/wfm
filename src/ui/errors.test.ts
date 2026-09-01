import { describe, expect, it } from 'vitest'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new Error('offered rate must be finite'))).toBe(
      'offered rate must be finite',
    )
  })

  it('stringifies non-Error throws', () => {
    expect(errorMessage('boom')).toBe('boom')
    expect(errorMessage(42)).toBe('42')
  })

  it('falls back to a fixed label for empty or opaque values', () => {
    expect(errorMessage(new Error(''))).toBe('unknown error')
    expect(errorMessage({})).toBe('unknown error')
  })
})
