import type { IntervalRecord } from './types'

export interface CsvError {
  /** 1-based line number in the input text */
  row: number
  message: string
}

export interface CsvParseResult {
  records: IntervalRecord[]
  errors: CsvError[]
}

export const CSV_HEADER = 'timestamp,queue,offered,aht'

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function validTimestamp(value: string): boolean {
  const m = TIMESTAMP_RE.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  return hour <= 23 && minute <= 59 && second <= 59
}

function parseNonNegativeNumber(value: string): number | null {
  if (value === '' || !/^-?\d+(\.\d+)?$/.test(value)) return null
  const n = Number(value)
  return n >= 0 ? n : null
}

export function parseCsv(text: string): CsvParseResult {
  const records: IntervalRecord[] = []
  const errors: CsvError[] = []
  // Excel saves "CSV UTF-8" with a byte-order mark; strip it so the header check passes.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.split(/\r\n|\r|\n/)

  const headerLine = lines[0]?.trim() ?? ''
  if (headerLine.toLowerCase() !== CSV_HEADER) {
    errors.push({ row: 1, message: `header must be "${CSV_HEADER}", got "${headerLine}"` })
    return { records, errors }
  }

  for (let i = 1; i < lines.length; i++) {
    const row = i + 1
    const line = lines[i].trim()
    if (line === '') continue

    const fields = line.split(',')
    if (fields.length !== 4) {
      errors.push({ row, message: `expected 4 columns, got ${fields.length}` })
      continue
    }

    const [ts, queue, offeredRaw, ahtRaw] = fields.map((f) => f.trim())
    const rowErrors: string[] = []

    if (!validTimestamp(ts)) rowErrors.push(`invalid timestamp "${ts}"`)
    if (queue === '') rowErrors.push('queue is empty')
    const offered = parseNonNegativeNumber(offeredRaw)
    if (offered === null) rowErrors.push(`offered must be a non-negative number, got "${offeredRaw}"`)
    const aht = parseNonNegativeNumber(ahtRaw)
    if (aht === null) rowErrors.push(`aht must be a non-negative number, got "${ahtRaw}"`)
    if (offered !== null && aht !== null && offered > 0 && aht <= 0) {
      rowErrors.push('aht must be positive when offered is positive')
    }

    if (rowErrors.length > 0 || offered === null || aht === null) {
      errors.push({ row, message: rowErrors.join('; ') })
      continue
    }

    records.push({ ts, queue, offered, aht })
  }

  return { records, errors }
}

export function serializeCsv(records: IntervalRecord[]): string {
  const lines = [CSV_HEADER]
  for (const r of records) {
    lines.push(`${r.ts},${r.queue},${r.offered},${r.aht}`)
  }
  return lines.join('\n') + '\n'
}

/** Example rows for the downloadable CSV template: two queues, three intervals each. */
export const TEMPLATE_RECORDS: IntervalRecord[] = [
  { ts: '2026-01-05T08:00', queue: 'voice-support', offered: 42, aht: 415 },
  { ts: '2026-01-05T08:30', queue: 'voice-support', offered: 51, aht: 402 },
  { ts: '2026-01-05T09:00', queue: 'voice-support', offered: 58, aht: 398 },
  { ts: '2026-01-05T08:00', queue: 'chat-support', offered: 12, aht: 610 },
  { ts: '2026-01-05T08:30', queue: 'chat-support', offered: 15, aht: 595 },
  { ts: '2026-01-05T09:00', queue: 'chat-support', offered: 18, aht: 600 },
]

/** CSV template text: header plus the example rows above. */
export function csvTemplate(): string {
  return serializeCsv(TEMPLATE_RECORDS)
}
