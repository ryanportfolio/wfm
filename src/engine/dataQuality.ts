import type { IntervalRecord } from './types'
import { datePart, dayNumFromIso, isoFromDayNum, timePart, weekdayOfDayNum } from './series'

export function intervalKey(record: Pick<IntervalRecord, 'queue' | 'ts'>): string {
  return JSON.stringify([record.queue.trim(), datePart(record.ts), timePart(record.ts)])
}

interface GapSummary {
  count: number
  samples: string[]
}

export interface QueueDataQuality {
  queue: string
  missingDates: GapSummary
  /** Only observed dates; wholly missing dates are counted separately. */
  missingSlots: GapSummary
  zeroRows: number
}

const SAMPLE_LIMIT = 5

/** Diagnostics only. Does not impute rows or change forecasting assumptions. */
export function analyzeDataQuality(records: IntervalRecord[]): QueueDataQuality[] {
  const queues = new Map<string, Map<number, Map<string, number>>>()
  for (const record of records) {
    let dates = queues.get(record.queue)
    if (!dates) queues.set(record.queue, (dates = new Map()))
    const date = dayNumFromIso(datePart(record.ts))
    let slots = dates.get(date)
    if (!slots) dates.set(date, (slots = new Map()))
    slots.set(timePart(record.ts), record.offered)
  }

  return [...queues].sort(([a], [b]) => a.localeCompare(b)).map(([queue, dates]) => {
    const report: QueueDataQuality = {
      queue, missingDates: { count: 0, samples: [] },
      missingSlots: { count: 0, samples: [] }, zeroRows: 0,
    }
    const ordered = [...dates.keys()].sort((a, b) => a - b)
    const weekdayDates = Array<number>(7).fill(0)
    const weekdaySlots = Array.from({ length: 7 }, () => new Map<string, number>())
    for (const [date, slots] of dates) {
      const weekday = weekdayOfDayNum(date)
      weekdayDates[weekday]++
      for (const [slot, offered] of slots) {
        weekdaySlots[weekday].set(slot, (weekdaySlots[weekday].get(slot) ?? 0) + 1)
        if (offered === 0) report.zeroRows++
      }
    }
    const expected = weekdaySlots.map((slots, weekday) => [...slots]
      .filter(([, count]) => count >= 2 && count > weekdayDates[weekday] / 2)
      .map(([slot]) => slot).sort())

    for (let i = 0; i < ordered.length; i++) {
      const date = ordered[i]
      if (i > 0) {
        const gap = date - ordered[i - 1] - 1
        report.missingDates.count += gap
        for (let n = 1; n <= gap && report.missingDates.samples.length < SAMPLE_LIMIT; n++) {
          report.missingDates.samples.push(isoFromDayNum(ordered[i - 1] + n))
        }
      }
      for (const slot of expected[weekdayOfDayNum(date)]) {
        if (dates.get(date)!.has(slot)) continue
        report.missingSlots.count++
        if (report.missingSlots.samples.length < SAMPLE_LIMIT) {
          report.missingSlots.samples.push(`${isoFromDayNum(date)}T${slot}`)
        }
      }
    }
    return report
  })
}
