import { describe, expect, it } from 'vitest'
import { parseCsv, serializeCsv, CSV_HEADER } from './csv'
import { generateSampleData } from './sampleData'

describe('csv round-trip', () => {
  it('serialize then parse returns the same records', () => {
    const sample = generateSampleData().slice(1000, 1500)
    const text = serializeCsv(sample)
    const result = parseCsv(text)
    expect(result.errors).toEqual([])
    expect(result.records).toEqual(sample)
  })
})

describe('parseCsv', () => {
  it('requires the exact header', () => {
    const result = parseCsv('time,queue,offered,aht\n2026-01-02T08:00:00,q,5,400\n')
    expect(result.records).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(1)
    expect(result.errors[0].message).toContain(CSV_HEADER)
  })

  it('rejects bad rows with their row numbers and keeps good ones', () => {
    const text = [
      CSV_HEADER,
      '2026-01-02T08:00:00,voice-benefits,42,415',
      '2026-01-02T08:30:00,voice-benefits,42',
      '2026-01-02T09:00:00,voice-benefits,forty,415',
      'not-a-timestamp,voice-benefits,42,415',
      '2026-01-02T10:00:00,,42,415',
      '2026-01-02T10:30:00,voice-benefits,42,-3',
      '2026-01-02T11:00:00,chat-support,7,610',
    ].join('\n')

    const result = parseCsv(text)
    expect(result.records).toHaveLength(2)
    expect(result.records[0].queue).toBe('voice-benefits')
    expect(result.records[1].ts).toBe('2026-01-02T11:00:00')
    expect(result.errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7])
    expect(result.errors[0].message).toContain('4 columns')
    expect(result.errors[1].message).toContain('offered')
    expect(result.errors[2].message).toContain('timestamp')
    expect(result.errors[3].message).toContain('queue')
    expect(result.errors[4].message).toContain('aht')
  })

  it('skips blank lines and handles CRLF', () => {
    const text = `${CSV_HEADER}\r\n2026-01-02T08:00:00,q1,5,400\r\n\r\n2026-01-02T08:30:00,q1,6,410\r\n`
    const result = parseCsv(text)
    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(2)
  })
})

describe('calendar and AHT validation (codex review fixes)', () => {
  it('rejects impossible calendar dates', () => {
    const text = `${CSV_HEADER}\n2026-02-31T09:00,q,10,300\n2025-02-29T09:00,q,10,300\n2026-04-31T09:00,q,10,300\n`
    const result = parseCsv(text)
    expect(result.records).toEqual([])
    expect(result.errors.map((e) => e.row)).toEqual([2, 3, 4])
  })

  it('accepts a real leap day', () => {
    const result = parseCsv(`${CSV_HEADER}\n2024-02-29T09:00,q,10,300\n`)
    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(1)
  })

  it('rejects zero AHT on positive-volume rows, accepts it on zero-volume rows', () => {
    const text = `${CSV_HEADER}\n2026-03-02T09:00,q,10,0\n2026-03-02T09:30,q,0,0\n`
    const result = parseCsv(text)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(2)
    expect(result.records).toHaveLength(1)
  })
})
