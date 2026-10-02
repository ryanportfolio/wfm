// Builds public/data/halifax-311.csv from Halifax Regional Municipality's
// "311 Call Volumes" open dataset.
//
//   node scripts/fetch-halifax-311.mjs            # reuse cached pages
//   node scripts/fetch-halifax-311.mjs --refresh  # download every page again
//
// Raw ArcGIS JSON pages are cached under .tmp/halifax-311/raw/ (gitignored),
// so a rerun only downloads what is missing. No dependencies: Node 18+ fetch.
//
// Contains information licenced under the Open Government Licence—Halifax.
// Source: https://data-hrm.hub.arcgis.com/datasets/HRM::311-call-volumes/about
// Licence: https://data-hrm.hub.arcgis.com/pages/open-data-licence
// The output is derived (re-aggregated and recomputed) from the source; see
// docs/backtest-halifax.md for every transformation and its evidence.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const QUERY_URL =
  'https://services2.arcgis.com/11XBiaBYA9Ep0yNJ/arcgis/rest/services/311_Call_Volumes/FeatureServer/0/query'
// The layer's maxRecordCount is 2,000 rows per request.
const PAGE_SIZE = 2000
const CACHE_DIR = '.tmp/halifax-311/raw'
const OUT_FILE = 'public/data/halifax-311.csv'
const EVIDENCE_FILE = 'scripts/halifax-311-evidence.json'
const QUEUE = 'halifax-311'
const FIRST_DATE = '2017-01-01'

// The source has two defects that start partway through it. Neither is
// corrected: the CSV stops the day before the earlier one, and checks() fails
// the run if the evidence below stops holding.
//
// Defect 1, hour shift from 2024-07-17. Up to 2024-07-16 the
// handled-call-weighted mean hour of every day with 100+ handled calls lies
// between 11.0 and 16.5. On 2024-07-17 handled calls start at 14:30, the mean
// hour is 19.7 and the day has only 29 rows; from then on weekday handled
// calls start in the 15:00 slot in daylight time and 16:00 in standard time,
// against 08:00 before: the hour field is 7 or 8 hours late.
const HOUR_SHIFT_FROM = '2024-07-17'

// Defect 2, double counting from 2023-05-23. HANDLED, ABANDONED and
// TOTAL_TALK_TIME are doubled on most days from this date to the hour shift.
// Before it, 29-74% (median 54%) of each day's nonzero values in those three
// fields are odd, over 2,324 days with 20+ such values. From 2023-05-23 to
// 2024-07-16, 395 open days have 0-7.5% odd values (doubling makes every count
// even) and 12 days have 46-65%, the normal spread, at 35-57% of the volume
// of the same weekday around them. OFFERED and PROCESSED_IN_IVR keep their
// normal parity mix. Which days are doubled can only be inferred, so the
// window is dropped rather than halved.
const DOUBLED_FROM = '2023-05-23'

// Last date written: the day before the earlier defect.
const LAST_KEPT_DATE = '2023-05-22'

// Dates whose daytime slots are absent although the centre was open, so the
// omitted rows are lost data, not zero calls. They are left unfilled so the
// app's completeness report shows them as missing expected slots.
// 2019-05-26 (Sunday): only 19 rows, none for the 04:30 to 17:30 slots.
const OUTAGE_DATES = new Set(['2019-05-26'])

const refresh = process.argv.includes('--refresh')

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const json = JSON.parse(text)
      if (json.error) throw new Error(JSON.stringify(json.error))
      return { json, text }
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`)
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
}

async function fetchRows() {
  if (refresh) await rm(CACHE_DIR, { recursive: true, force: true })
  await mkdir(CACHE_DIR, { recursive: true })
  const manifestFile = join(CACHE_DIR, 'manifest.json')
  let count
  if (existsSync(manifestFile)) {
    count = JSON.parse(await readFile(manifestFile, 'utf8')).count
  } else {
    count = (await getJson(`${QUERY_URL}?where=1%3D1&returnCountOnly=true&f=json`)).json.count
    await writeFile(manifestFile, JSON.stringify({ count, fetchedAt: new Date().toISOString() }))
  }
  let downloaded = 0
  for (let offset = 0; offset < count; offset += PAGE_SIZE) {
    const file = join(CACHE_DIR, `page-${String(offset).padStart(7, '0')}.json`)
    if (existsSync(file)) continue
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      orderByFields: 'ObjectId ASC',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'json',
    })
    const { text } = await getJson(`${QUERY_URL}?${params}`)
    await writeFile(file, text)
    downloaded++
  }
  const rows = []
  for (const name of (await readdir(CACHE_DIR)).filter((f) => f.startsWith('page-')).sort()) {
    const page = JSON.parse(await readFile(join(CACHE_DIR, name), 'utf8'))
    for (const feature of page.features) rows.push(feature.attributes)
  }
  const ids = new Set(rows.map((r) => r.ObjectId))
  if (rows.length !== count || ids.size !== count) {
    throw new Error(`expected ${count} unique rows, got ${rows.length} (${ids.size} unique); rerun with --refresh`)
  }
  console.log(`source rows: ${count} (${downloaded} pages downloaded, rest from cache)`)
  return rows
}

const pad2 = (n) => String(n).padStart(2, '0')

// CALL_DATE is a local date stored as epoch ms. HRM's 2018 metadata says it
// sits at 04:00 UTC (midnight AST); the current data has 07:00 or 08:00 UTC
// (local midnight in US Pacific time). Either way the UTC calendar date is
// the source's local date.
function dateOf(row) {
  const d = new Date(row.CALL_DATE)
  const h = d.getUTCHours()
  if ((h !== 7 && h !== 8) || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0) {
    throw new Error(`ObjectId ${row.ObjectId}: unexpected CALL_DATE time ${d.toISOString()}`)
  }
  return d.toISOString().slice(0, 10)
}

// INTERVAL is "hh:mm AM - hh:mm PM"; its start hour must match MILITARY_HOUR.
function slotOf(row) {
  const m = /^(\d{2}):(00|30) (AM|PM) - /.exec(row.INTERVAL)
  if (!m) throw new Error(`ObjectId ${row.ObjectId}: unexpected INTERVAL "${row.INTERVAL}"`)
  const hour = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)
  if (hour !== row.MILITARY_HOUR) {
    throw new Error(`ObjectId ${row.ObjectId}: INTERVAL "${row.INTERVAL}" vs MILITARY_HOUR ${row.MILITARY_HOUR}`)
  }
  return hour * 2 + (m[2] === '30' ? 1 : 0)
}

const slotTime = (slot) => `${pad2(Math.floor(slot / 2))}:${slot % 2 ? '30' : '00'}`

function addDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Handled-call-weighted mean hour of day (slot midpoints), or null below 100 handled calls. */
function handledMeanHour(rows) {
  let handled = 0
  let weighted = 0
  for (const r of rows) {
    handled += r.HANDLED
    weighted += r.HANDLED * (slotOf(r) / 2 + 0.25)
  }
  return handled >= 100 ? weighted / handled : null
}

/** Share of a day's nonzero HANDLED, ABANDONED and TOTAL_TALK_TIME values that are odd, or null below 20 values. */
function oddShare(rows) {
  let values = 0
  let odd = 0
  for (const r of rows) {
    for (const v of [r.HANDLED, r.ABANDONED, r.TOTAL_TALK_TIME]) {
      if (v > 0) {
        values++
        if (v % 2 === 1) odd++
      }
    }
  }
  return values >= 20 ? odd / values : null
}

/** Fails the run unless the source still shows both defects where documented, and neither inside the kept window. */
function checks(byDate) {
  const failures = []
  const offHours = []
  const doubledKept = []
  let windowDays = 0
  let windowDoubled = 0
  for (const [date, rows] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (date < HOUR_SHIFT_FROM) {
      const mean = handledMeanHour(rows)
      if (mean !== null && (mean < 10 || mean > 17)) offHours.push(`${date} ${mean.toFixed(1)}`)
    }
    const share = oddShare(rows)
    if (share === null) continue
    if (date <= LAST_KEPT_DATE && share < 0.2) doubledKept.push(`${date} ${(share * 100).toFixed(0)}% odd`)
    if (date >= DOUBLED_FROM && date < HOUR_SHIFT_FROM) {
      windowDays++
      if (share < 0.1) windowDoubled++
    }
  }
  if (offHours.length) failures.push(`days before ${HOUR_SHIFT_FROM} centred outside 10:00-17:00: ${offHours.slice(0, 5).join(', ')}`)
  const shifted = handledMeanHour(byDate.get(HOUR_SHIFT_FROM) ?? [])
  if (shifted === null || shifted <= 17) failures.push(`${HOUR_SHIFT_FROM} is not shifted (mean hour ${shifted?.toFixed(1)})`)
  if (doubledKept.length) failures.push(`doubled days inside the kept window: ${doubledKept.slice(0, 5).join(', ')}`)
  if (windowDays === 0 || windowDoubled / windowDays < 0.9) {
    failures.push(`only ${windowDoubled} of ${windowDays} open days from ${DOUBLED_FROM} look doubled`)
  }
  const firstOpen = [...byDate.keys()].filter((d) => d >= DOUBLED_FROM && oddShare(byDate.get(d)) !== null).sort()[0]
  if (!firstOpen || oddShare(byDate.get(firstOpen)) >= 0.1) failures.push(`first open day from ${DOUBLED_FROM} (${firstOpen}) is not doubled`)
  if (failures.length) throw new Error(`source checks failed:\n- ${failures.join('\n- ')}`)
  console.log(`checks passed: ${windowDoubled} of ${windowDays} open days from ${DOUBLED_FROM} to the hour shift doubled; none up to ${LAST_KEPT_DATE}`)
}

const quantile = (sorted, q) => sorted[Math.floor(sorted.length * q)]
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())

/** Earliest weekday slot from 06:00 holding at least 5% of the busiest slot's handled calls. */
function openingSlot(dates, byDate) {
  const handled = new Array(48).fill(0)
  for (const date of dates) for (const r of byDate.get(date)) handled[slotOf(r)] += r.HANDLED
  const max = Math.max(...handled)
  return slotTime(handled.findIndex((v, s) => s >= 12 && v >= 0.05 * max))
}

/**
 * Every source-derived figure that docs/backtest-halifax.md quotes, written to
 * EVIDENCE_FILE so scripts/halifaxReport.test.ts can pin the prose to it.
 */
function evidence(rows, byDate) {
  const dates = [...byDate.keys()].sort()
  const kept = rows.filter((r) => dateOf(r) <= LAST_KEPT_DATE)
  const utcHours = rows.map((r) => new Date(r.CALL_DATE).getUTCHours())

  // Hour shift.
  const preMeans = dates
    .filter((d) => d < HOUR_SHIFT_FROM)
    .map((d) => handledMeanHour(byDate.get(d)))
    .filter((m) => m !== null)
  const shiftDay = byDate.get(HOUR_SHIFT_FROM)
  const weekdaysAfter = dates.filter((d) => d >= HOUR_SHIFT_FROM && !isWeekend(d))
  const utcHourOf = (d) => new Date(byDate.get(d)[0].CALL_DATE).getUTCHours()
  const weekdays2023 = dates.filter((d) => d.startsWith('2023-') && !isWeekend(d))
  const months2023 = [...new Set(weekdays2023.map((d) => d.slice(0, 7)))]

  // Double counting.
  const preShares = dates.filter((d) => d < DOUBLED_FROM).map((d) => oddShare(byDate.get(d))).filter((s) => s !== null).sort((a, b) => a - b)
  const windowDates = dates.filter((d) => d >= DOUBLED_FROM && d < HOUR_SHIFT_FROM && oddShare(byDate.get(d)) !== null)
  const doubled = windowDates.filter((d) => oddShare(byDate.get(d)) < 0.1)
  const single = windowDates.filter((d) => oddShare(byDate.get(d)) >= 0.1)
  const agentCalls = (d) => (byDate.get(d) ?? []).reduce((s, r) => s + r.HANDLED + r.ABANDONED, 0)
  const singleRatios = single.map((d) => {
    const around = [-21, -14, -7, 7, 14, 21]
      .map((k) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10) })
      .filter((x) => byDate.has(x) && !single.includes(x) && agentCalls(x) > 0)
      .map(agentCalls)
      .sort((a, b) => a - b)
    return agentCalls(d) / around[Math.floor(around.length / 2)]
  })
  const windowRows = rows.filter((r) => dateOf(r) >= DOUBLED_FROM && dateOf(r) < HOUR_SHIFT_FROM)
  const monthMean = (month, scale) => {
    const ds = dates.filter((d) => d.startsWith(month))
    return ds.reduce((s, d) => s + agentCalls(d) * scale(d), 0) / ds.length
  }
  const end = dates[dates.length - 1]
  const firstDropped = DOUBLED_FROM
  const monthsDropped =
    (Number(end.slice(0, 4)) - Number(firstDropped.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(firstDropped.slice(5, 7)) -
    (end.slice(8) < firstDropped.slice(8) ? 1 : 0)

  // Reconciliation over the kept range.
  const sums = (rs) => rs.reduce((a, r) => ({ O: a.O + r.OFFERED, H: a.H + r.HANDLED, A: a.A + r.ABANDONED, I: a.I + r.PROCESSED_IN_IVR }), { O: 0, H: 0, A: 0, I: 0 })
  const total = sums(kept)
  const open = sums(kept.filter((r) => r.MILITARY_HOUR >= 8 && r.MILITARY_HOUR <= 19))
  const closed = sums(kept.filter((r) => r.MILITARY_HOUR < 8 || r.MILITARY_HOUR > 19))
  const gap = (t) => t.O - t.H - t.A - t.I
  const dayGaps = dates.filter((d) => d <= LAST_KEPT_DATE).map((d) => {
    const t = sums(byDate.get(d))
    return gap(t) / t.O
  }).sort((a, b) => a - b)

  // Omitted intervals in the kept range.
  const night = (s) => s < 14 || s >= 42
  const keptDates = dates.filter((d) => d <= LAST_KEPT_DATE)
  let omitted = 0
  let nightOmitted = 0
  let nightPresent = 0
  let nightNone = 0
  let nightCalls = 0
  let allCalls = 0
  const daytimeGaps = new Map()
  for (const d of keptDates) {
    const present = new Map(byDate.get(d).map((r) => [slotOf(r), r]))
    for (let s = 0; s < 48; s++) {
      const r = present.get(s)
      if (!r) {
        omitted++
        if (night(s)) nightOmitted++
        else if (s >= 16 && s < 40 && !OUTAGE_DATES.has(d)) daytimeGaps.set(d, (daytimeGaps.get(d) ?? 0) + 1)
        continue
      }
      const calls = r.HANDLED + r.ABANDONED
      allCalls += calls
      if (night(s)) {
        nightPresent++
        nightCalls += calls
        if (calls === 0) nightNone++
      }
    }
  }
  const rowsPerDay = keptDates.map((d) => byDate.get(d).length).sort((a, b) => a - b)
  const withHandled = rows.filter((r) => r.HANDLED > 0)

  return {
    source: { rows: rows.length, lastDate: end, utc07Rows: utcHours.filter((h) => h === 7).length, utc08Rows: utcHours.filter((h) => h === 8).length },
    timestamps2023: {
      weekdayMonths: months2023.length,
      monthsOpeningAt0800: months2023.filter((m) => openingSlot(weekdays2023.filter((d) => d.startsWith(m)), byDate) === '08:00').length,
      handledAt0700: weekdays2023.reduce((s, d) => s + byDate.get(d).filter((r) => r.MILITARY_HOUR === 7).reduce((a, r) => a + r.HANDLED, 0), 0),
    },
    hourShift: {
      preMeanHourMin: Math.min(...preMeans),
      preMeanHourMax: Math.max(...preMeans),
      shiftDayFirstHandled: slotTime(Math.min(...shiftDay.filter((r) => r.HANDLED > 0).map(slotOf))),
      shiftDayMeanHour: handledMeanHour(shiftDay),
      shiftDayRows: shiftDay.length,
      openingDaylight: openingSlot(weekdaysAfter.filter((d) => utcHourOf(d) === 7), byDate),
      openingStandard: openingSlot(weekdaysAfter.filter((d) => utcHourOf(d) === 8), byDate),
    },
    doubling: {
      preOddMin: preShares[0],
      preOddMedian: quantile(preShares, 0.5),
      preOddMax: preShares[preShares.length - 1],
      preDays: preShares.length,
      windowOpenDays: windowDates.length,
      doubledDays: doubled.length,
      doubledOddMin: Math.min(...doubled.map((d) => oddShare(byDate.get(d)))),
      doubledOddMax: Math.max(...doubled.map((d) => oddShare(byDate.get(d)))),
      singleDays: single.length,
      singleOddMin: Math.min(...single.map((d) => oddShare(byDate.get(d)))),
      singleOddMax: Math.max(...single.map((d) => oddShare(byDate.get(d)))),
      singleVolumeRatioMin: Math.min(...singleRatios),
      singleVolumeRatioMax: Math.max(...singleRatios),
      windowRows: windowRows.length,
      offeredEqualsDoubledRows: windowRows.filter((r) => r.OFFERED === r.HANDLED + r.ABANDONED + r.PROCESSED_IN_IVR).length,
      january2024HalvedPerDay: monthMean('2024-01', (d) => (doubled.includes(d) ? 0.5 : 1)),
      january2023PerDay: monthMean('2023-01', () => 1),
      monthsDropped,
    },
    reconciliation: {
      rows: kept.length,
      exactRows: kept.filter((r) => r.OFFERED === r.HANDLED + r.ABANDONED + r.PROCESSED_IN_IVR).length,
      withinOneRows: kept.filter((r) => Math.abs(gap(sums([r]))) <= 1).length,
      offeredSmallerRows: kept.filter((r) => gap(sums([r])) < 0).length,
      offered: total.O,
      ivr: total.I,
      agent: total.H + total.A,
      gap: gap(total),
      dayGapP05: quantile(dayGaps, 0.05),
      dayGapP50: quantile(dayGaps, 0.5),
      dayGapP95: quantile(dayGaps, 0.95),
      negativeGapDays: dayGaps.filter((g) => g < 0).length,
      openGap: gap(open),
      openIvr: open.I,
      openAgent: open.H + open.A,
      closedGap: gap(closed),
      closedIvr: closed.I,
      closedAgent: closed.H + closed.A,
    },
    talk: {
      rowsWithHandled: withHandled.length,
      averageIsFloorRows: withHandled.filter((r) => Math.floor(r.TOTAL_TALK_TIME / r.HANDLED) === r.AVERAGE_TALK_TIME).length,
    },
    omitted: {
      zeroOfferedRows: kept.filter((r) => r.OFFERED === 0).length,
      rowsPerDayP05: quantile(rowsPerDay, 0.05),
      rowsPerDayP95: quantile(rowsPerDay, 0.95),
      omittedSlots: omitted,
      nightOmittedSlots: nightOmitted,
      nightPresentMeanCalls: nightCalls / nightPresent,
      nightPresentNoneShare: nightNone / nightPresent,
      nightCallShare: nightCalls / allCalls,
      outageDayRows: [...OUTAGE_DATES].map((d) => byDate.get(d).length),
      daytimeGapDates: daytimeGaps.size,
      daytimeGapMaxSlots: Math.max(...daytimeGaps.values()),
      daytimeGapDatesWeekendOrClosed: [...daytimeGaps.keys()].filter((d) => isWeekend(d) || agentCalls(d) === 0).length,
    },
  }
}

function round1(x) {
  return Math.round(x * 10) / 10
}

async function main() {
  const rows = await fetchRows()
  const byDate = new Map()
  for (const r of rows) {
    const date = dateOf(r)
    slotOf(r)
    let list = byDate.get(date)
    if (!list) byDate.set(date, (list = []))
    list.push(r)
  }
  checks(byDate)

  let talk = 0
  let handled = 0
  for (const [date, dayRows] of byDate) {
    if (date > LAST_KEPT_DATE) continue
    for (const r of dayRows) {
      talk += r.TOTAL_TALK_TIME
      handled += r.HANDLED
    }
  }
  const overallTalk = talk / handled

  const lines = ['timestamp,queue,offered,aht']
  const stats = { days: 0, sourceRows: 0, filled: 0, outageSlots: 0, abandonOnly: 0, abandonOnlyRangeMean: 0, offered: 0 }
  for (let date = FIRST_DATE; date <= LAST_KEPT_DATE; date = addDay(date)) {
    const dayRows = byDate.get(date) ?? []
    stats.days++
    stats.sourceRows += dayRows.length
    const bySlot = new Map()
    for (const r of dayRows) {
      const slot = slotOf(r)
      if (bySlot.has(slot)) throw new Error(`duplicate ${date} ${slotTime(slot)}`)
      bySlot.set(slot, r)
    }
    let dayTalk = 0
    let dayHandled = 0
    for (const r of dayRows) {
      dayTalk += r.TOTAL_TALK_TIME
      dayHandled += r.HANDLED
    }
    // Abandon-only intervals have demand but no talk time; they borrow the
    // day's mean talk time (the whole range's mean if nothing was handled).
    const dayHasTalk = dayHandled > 0 && dayTalk > 0
    const fallbackTalk = dayHasTalk ? dayTalk / dayHandled : overallTalk
    for (let slot = 0; slot < 48; slot++) {
      const ts = `${date}T${slotTime(slot)}`
      const r = bySlot.get(slot)
      if (!r) {
        if (OUTAGE_DATES.has(date)) {
          stats.outageSlots++
          continue
        }
        stats.filled++
        lines.push(`${ts},${QUEUE},0,0`)
        continue
      }
      // Agent demand: calls that reached the agent queue (answered or
      // abandoned). Calls completed in the IVR never needed an agent.
      const offered = r.HANDLED + r.ABANDONED
      let aht = 0
      if (offered > 0) {
        if (r.HANDLED > 0 && r.TOTAL_TALK_TIME > 0) {
          aht = r.TOTAL_TALK_TIME / r.HANDLED
        } else {
          aht = fallbackTalk
          stats.abandonOnly++
          if (!dayHasTalk) stats.abandonOnlyRangeMean++
        }
      }
      stats.offered += offered
      lines.push(`${ts},${QUEUE},${offered},${round1(aht)}`)
    }
  }
  const text = lines.join('\n') + '\n'
  await mkdir('public/data', { recursive: true })
  await writeFile(OUT_FILE, text)
  const facts = evidence(rows, byDate)
  facts.talk.noTalkTimeRows = stats.abandonOnly
  await writeFile(EVIDENCE_FILE, JSON.stringify(facts, null, 2) + '\n')
  console.log(
    `wrote ${OUT_FILE}: ${lines.length - 1} rows, ${FIRST_DATE}..${LAST_KEPT_DATE} (${stats.days} days), ` +
      `${(text.length / 1e6).toFixed(2)} MB`,
  )
  console.log(
    `source rows used: ${stats.sourceRows}; zero-filled slots: ${stats.filled}; ` +
      `outage slots left missing: ${stats.outageSlots}; abandon-only intervals given the day's talk time: ` +
      `${stats.abandonOnly} (${stats.abandonOnlyRangeMean} used the range mean); agent-queue calls: ${stats.offered}`,
  )
}

await main()
