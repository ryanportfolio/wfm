import { civilFromDays, dayNumFromIso, daysFromCivil, isoFromDayNum, weekdayOfDayNum } from './series'

/** Day number of the nth `weekday` (0 = Sunday) of month m in year y. */
function nthWeekdayDayNum(y: number, m: number, weekday: number, n: number): number {
  const first = daysFromCivil(y, m, 1)
  const offset = (weekday - weekdayOfDayNum(first) + 7) % 7
  return first + offset + (n - 1) * 7
}

/** Day number of the last `weekday` (0 = Sunday) of month m in year y. */
function lastWeekdayDayNum(y: number, m: number, weekday: number): number {
  const last = daysFromCivil(y, m + 1, 1) - 1
  const back = (weekdayOfDayNum(last) - weekday + 7) % 7
  return last - back
}

/** Federal observance shift: Saturday holidays observed Friday, Sunday ones Monday. */
function observedDayNum(z: number): number {
  const w = weekdayOfDayNum(z)
  if (w === 6) return z - 1
  if (w === 0) return z + 1
  return z
}

/**
 * US federal holidays (actual and observed dates) within [startDate, endDate],
 * as sorted ISO dates.
 */
export function usHolidays(startDate: string, endDate: string): string[] {
  const startNum = dayNumFromIso(startDate)
  const endNum = dayNumFromIso(endDate)
  const startYear = civilFromDays(startNum).y
  const endYear = civilFromDays(endNum).y
  const out = new Set<number>()

  for (let y = startYear - 1; y <= endYear + 1; y++) {
    const fixed = [
      daysFromCivil(y, 1, 1), // New Year's Day
      daysFromCivil(y, 6, 19), // Juneteenth
      daysFromCivil(y, 7, 4), // Independence Day
      daysFromCivil(y, 11, 11), // Veterans Day
      daysFromCivil(y, 12, 25), // Christmas Day
    ]
    for (const z of fixed) {
      out.add(z)
      out.add(observedDayNum(z))
    }
    out.add(nthWeekdayDayNum(y, 1, 1, 3)) // MLK Day
    out.add(nthWeekdayDayNum(y, 2, 1, 3)) // Washington's Birthday
    out.add(lastWeekdayDayNum(y, 5, 1)) // Memorial Day
    out.add(nthWeekdayDayNum(y, 9, 1, 1)) // Labor Day
    out.add(nthWeekdayDayNum(y, 10, 1, 2)) // Columbus Day
    out.add(nthWeekdayDayNum(y, 11, 4, 4)) // Thanksgiving
  }

  return [...out]
    .filter((z) => z >= startNum && z <= endNum)
    .sort((a, b) => a - b)
    .map(isoFromDayNum)
}
