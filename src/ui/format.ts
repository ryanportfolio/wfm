import { weekdayOfIso } from '../engine/series'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Rounded integer with thousands separators. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Fixed decimals with thousands separators. */
export function fmtNum(n: number, digits = 1): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** Fraction to percent, one decimal by default: 0.815 -> "81.5%". */
export function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`
}

/** Signed percent from a fraction: 0.021 -> "+2.1%". */
export function fmtSignedPct(fraction: number, digits = 1): string {
  const v = fraction * 100
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

/** Signed plain number: 12.3 -> "+12.3". */
export function fmtSigned(n: number, digits = 1): string {
  return `${n >= 0 ? '+' : ''}${fmtNum(n, digits)}`
}

/** Compact axis label: 12400 -> "12.4k". */
export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return fmtInt(n)
}

/** "2026-08-16" -> "Aug 16" */
export function fmtDateShort(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`
}

/** "2026-08-16" -> "Aug 16, 2026" */
export function fmtDateLong(iso: string): string {
  return `${fmtDateShort(iso)}, ${iso.slice(0, 4)}`
}

/** "2026-08-16" -> "Sun, Aug 16" */
export function fmtDateWeekday(iso: string): string {
  return `${WEEKDAYS[weekdayOfIso(iso)]}, ${fmtDateShort(iso)}`
}

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday]
}

/** "2026-08-16T09:30:00" -> "09:30" */
export function fmtTime(ts: string): string {
  return ts.slice(11, 16)
}

/** Seconds with unit, e.g. "18.4 s". */
export function fmtSec(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return 'n/a'
  return `${fmtNum(n, digits)} s`
}
