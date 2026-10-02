// Figure pin for the Halifax 311 write-up. Recomputes the backtest from the
// committed CSV, reads the source evidence that scripts/fetch-halifax-311.mjs
// writes, and fails when docs/backtest-halifax.md or the README quote a figure
// that no longer matches its computed value.
import { describe, expect, it } from 'vitest'
import { fmtInt, fmtPct, fmtSignedPct } from '../src/ui/format'
import csv from '../public/data/halifax-311.csv?raw'
import docText from '../docs/backtest-halifax.md?raw'
import readmeText from '../README.md?raw'
import ev from './halifax-311-evidence.json'
import { buildHalifaxReport } from './halifaxReport'

const normalize = (text: string) => text.replace(/\r\n/g, '\n')
const percents = (text: string) => text.match(/\d+\.\d%/g) ?? []
const pct0 = (x: number) => fmtPct(x, 0)
const n1 = (x: number) => x.toFixed(1)
const n2 = (x: number) => x.toFixed(2)
/** Difference in points between two fractions as the tables display them. */
const points = (a: number, b: number) => (Math.round(a * 1000) / 10 - Math.round(b * 1000) / 10).toFixed(1)

/** Text from a heading line to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`missing heading "${heading}"`)
  const level = heading.match(/^#+/)![0]
  const rest = text.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `))
  return next < 0 ? rest : rest.slice(0, next)
}

describe('Halifax 311 write-up figures', { timeout: 60_000 }, () => {
  const report = buildHalifaxReport(csv)
  const f = report.facts
  const doc = normalize(docText)
  const readme = normalize(readmeText)
  const computed = new Set(report.sections.flatMap((s) => percents(s.body)))

  it('quotes every recomputed table and list verbatim in the write-up', () => {
    for (const { title, body } of report.sections) {
      expect(doc, title).toContain(`### ${title}\n\n${body}\n`)
    }
  })

  it('pins every figure in the prose to its own computed value', () => {
    // Everything except the Results section, whose blocks are pinned verbatim above.
    const results = doc.indexOf('\n## Results\n')
    const prose = doc.slice(0, results) + doc.slice(results + 1 + section(doc, '## Results').length + '## Results\n'.length)
    const r = ev.reconciliation
    const d = ev.doubling
    const o = ev.omitted
    const hourOf = (slot: string) => Number(slot.slice(0, 2))
    const sample = percents(readme.split('\n').find((l) => l.startsWith('**Accuracy.**'))!).map((p) => parseFloat(p))
    const testFrom = report.sections.find((s) => s.title.startsWith('Scorecard'))!.title.match(/test days (\d{4}-\d{2}-(\d{2}))/)!
    const dailyAll = (['sma', 'hw', 'dhr', 'equal', 'ensemble'] as const).map((m) => f[`wape.${m}.daily`])
    const openGain = (['sma', 'hw', 'dhr', 'equal', 'ensemble'] as const).map((m) => Number(points(f[`wape.${m}.daily`], f[`open.${m}`])))

    const pins: [RegExp, ...string[]][] = [
      // Intro, source, timestamps.
      [/on (\d+\.\d) years of real/, n1(f['csv.years'])],
      [/Fetched [\d-]+: ([\d,]+) rows, [\d-]+ to (\d{4}-\d{2}-\d{2})\./, fmtInt(ev.source.rows), ev.source.lastDate],
      [/07:00 UTC \(([\d,]+) rows\) or 08:00 UTC \(([\d,]+) rows\)/, fmtInt(ev.source.utc07Rows), fmtInt(ev.source.utc08Rows)],
      // Hour shift.
      [/runs (\d+) hours late in summer and (\d+) in winter/, String(hourOf(ev.hourShift.openingDaylight) - 8), String(hourOf(ev.hourShift.openingStandard) - 8)],
      [/start in the (\d\d:\d\d) slot during daylight saving time and the (\d\d:\d\d) slot in standard time/, ev.hourShift.openingDaylight, ev.hourShift.openingStandard],
      [/lies between (\d+\.\d) and (\d+\.\d)\. On/, n1(ev.hourShift.preMeanHourMin), n1(ev.hourShift.preMeanHourMax)],
      [/handled calls start at (\d\d:\d\d), the mean hour is (\d+\.\d) and the day has only (\d+) rows/, ev.hourShift.shiftDayFirstHandled, n1(ev.hourShift.shiftDayMeanHour), String(ev.hourShift.shiftDayRows)],
      // Double counting.
      [/Before it, (\d+%) to (\d+%) \(median (\d+%)\) of each day's nonzero values in those three fields are odd, over ([\d,]+) days/, pct0(d.preOddMin), pct0(d.preOddMax), pct0(d.preOddMedian), fmtInt(d.preDays)],
      [/(\d+) of (\d+) open days have (\d+%) to (\d+\.\d%) odd values/, String(d.doubledDays), String(d.windowOpenDays), pct0(d.doubledOddMin), fmtPct(d.doubledOddMax)],
      [/The other (\d+) days have (\d+%) to (\d+%), the normal spread, and carry (\d+%) to (\d+%) of the volume/, String(d.singleDays), pct0(d.singleOddMin), pct0(d.singleOddMax), pct0(d.singleVolumeRatioMin), pct0(d.singleVolumeRatioMax)],
      [/exactly on ([\d,]+) of the window's ([\d,]+) rows/, fmtInt(d.offeredEqualsDoubledRows), fmtInt(d.windowRows)],
      [/bring January 2024 to (\d+) agent-queue calls a day, against (\d+) in January 2023/, fmtInt(d.january2024HalvedPerDay), fmtInt(f['csv.jan2023'])],
      [/and (\d+) days in the window are not/, String(d.singleDays)],
      [/The cost is the last (\d+) months of the source/, String(d.monthsDropped)],
      [/The last (\d+) months of the source are not used/, String(d.monthsDropped)],
      // Reconciliation.
      [/2017-01-01 to 2023-05-22 \(([\d,]+) rows\):/, fmtInt(r.rows)],
      [/exactly on ([\d,]+) rows \((\d+\.\d%)\) and within one call on ([\d,]+) \((\d+\.\d%)\)/, fmtInt(r.exactRows), fmtPct(r.exactRows / r.rows), fmtInt(r.withinOneRows), fmtPct(r.withinOneRows / r.rows)],
      [/the smaller side on ([\d,]+) rows/, fmtInt(r.offeredSmallerRows)],
      [/([\d,]+) calls \((\d+\.\d%) of ([\d,]+) offered\) have no recorded outcome/, fmtInt(r.gap), fmtPct(r.gap / r.offered), fmtInt(r.offered)],
      [/runs from (\d+\.\d%) \(5th percentile\) through (\d+\.\d%) \(median\) to (\d+\.\d%) \(95th percentile\)/, fmtPct(r.dayGapP05), fmtPct(r.dayGapP50), fmtPct(r.dayGapP95)],
      [/the gap is ([\d,]+) calls: (\d+\.\d%) of the IVR-completed calls in those hours and (\d+\.\d%) of answered/, fmtInt(r.openGap), fmtPct(r.openGap / r.openIvr), fmtPct(r.openGap / r.openAgent)],
      [/it is ([\d,]+) calls: (\d+\.\d%) of IVR-completed calls but (\d+\.\d%) of answered/, fmtInt(r.closedGap), fmtPct(r.closedGap / r.closedIvr), fmtPct(r.closedGap / r.closedAgent)],
      [/would give ([\d,]+) - ([\d,]+) = ([\d,]+) calls; `HANDLED \+ ABANDONED` gives ([\d,]+), (\d+\.\d%) fewer/, fmtInt(r.offered), fmtInt(r.ivr), fmtInt(r.offered - r.ivr), fmtInt(r.agent), fmtPct(1 - r.agent / (r.offered - r.ivr))],
      [/IVR-completed calls and the (\d+\.\d%) of offered calls/, fmtPct(r.gap / r.offered)],
      // Talk time.
      [/on all ([\d,]+) source rows with handled calls/, fmtInt(ev.talk.rowsWithHandled)],
      [/the volume-weighted mean in the CSV is (\d+) seconds/, fmtInt(f['csv.ahtMean'])],
      [/no recorded talk time \(([\d,]+) rows:/, fmtInt(ev.talk.noTalkTimeRows)],
      // Omitted intervals and output.
      [/only (\d+) of the ([\d,]+) kept rows have `OFFERED` 0, and a day has (\d+) to (\d+) rows/, fmtInt(o.zeroOfferedRows), fmtInt(r.rows), String(o.rowsPerDayP05), String(o.rowsPerDayP95)],
      [/Of the ([\d,]+) omitted day-slots, ([\d,]+) \((\d+\.\d%)\) fall/, fmtInt(o.omittedSlots), fmtInt(o.nightOmittedSlots), fmtPct(o.nightOmittedSlots / o.omittedSlots)],
      [/average (\d+\.\d\d) agent-queue calls, (\d+\.\d%) of them have none, and night slots carry (\d+\.\d%) of agent-queue calls/, n2(o.nightPresentMeanCalls), fmtPct(o.nightPresentNoneShare), fmtPct(o.nightCallShare)],
      [/that day has (\d+) rows and none/, String(o.outageDayRows[0])],
      [/Its (\d+) missing slots stay missing/, fmtInt(f['csv.missingSlots'])],
      [/(\d+) other dates each miss (\d+) slot between/, String(o.daytimeGapDates), String(o.daytimeGapMaxSlots)],
      [/([\d,]+) rows \(48 slots for each of ([\d,]+) days, less the (\d+) outage slots\), [\d-]+ to [\d-]+, (\d+\.\d\d) MB/, fmtInt(f['csv.rows']), fmtInt(f['csv.days']), fmtInt(f['csv.missingSlots']), n2(f['csv.megabytes'])],
      // Reading the results.
      [/lowest WAPE at every grain: (\d+\.\d%) interval, (\d+\.\d%) daily, (\d+\.\d%) weekly/, fmtPct(f['wape.dhr.interval']), fmtPct(f['wape.dhr.daily']), fmtPct(f['wape.dhr.weekly'])],
      [/The ensemble is second at every grain \((\d+\.\d%), (\d+\.\d%), (\d+\.\d%)\)/, fmtPct(f['wape.ensemble.interval']), fmtPct(f['wape.ensemble.daily']), fmtPct(f['wape.ensemble.weekly'])],
      [/equal-weight blend third \((\d+\.\d%), (\d+\.\d%), (\d+\.\d%)\)/, fmtPct(f['wape.equal.interval']), fmtPct(f['wape.equal.daily']), fmtPct(f['wape.equal.weekly'])],
      [/by (\d+\.\d) points at interval grain and (\d+\.\d) at weekly grain/, points(f['wape.equal.interval'], f['wape.ensemble.interval']), points(f['wape.equal.weekly'], f['wape.ensemble.weekly'])],
      [/smallest bias, (-?\d+\.\d%), against (-?\d+\.\d%) for DHR/, fmtSignedPct(f['bias.ensemble.daily']), fmtSignedPct(f['bias.dhr.daily'])],
      [/Daily MAPE ties at (\d+\.\d%)/, fmtPct(f['mape.dhr.daily'])],
      [/fourth overall \((\d+\.\d%) daily WAPE\)/, fmtPct(f['wape.sma.daily'])],
      [/first two weeks \((\d+\.\d%) in days 1-7, (\d+\.\d%) in days 8-14\) and falls to (\d+\.\d%) in days 15-28/, fmtPct(f['lead.sma.1-7']), fmtPct(f['lead.sma.8-14']), fmtPct(f['lead.sma.15-28'])],
      [/The ensemble trails it early \((\d+\.\d%) in days 1-7\)/, fmtPct(f['lead.ensemble.1-7'])],
      [/give Holt-Winters (\d+%) of the 1-3 day blend/, pct0(f['weight.1-3d.hw'])],
      [/weakest method at every lead time here \((\d+\.\d%) in days 1-7, (\d+\.\d%) in days 15-28\)/, fmtPct(f['lead.hw.1-7']), fmtPct(f['lead.hw.15-28'])],
      [/In F7 and F6 it over-forecasts by (\+\d+\.\d%) and (\+\d+\.\d%)/, fmtSignedPct(f['foldBias.sma.F7']), fmtSignedPct(f['foldBias.sma.F6'])],
      [/averaged (\d+) and (\d+) calls a day, while the test windows averaged (\d+) and (\d+)\./, fmtInt(f['prior.F7']), fmtInt(f['prior.F6']), fmtInt(f['actual.F7']), fmtInt(f['actual.F6'])],
      [/stays closer \((\+\d+\.\d%) and (\+\d+\.\d%)\)/, fmtSignedPct(f['foldBias.dhr.F7']), fmtSignedPct(f['foldBias.dhr.F6'])],
      [/in F7 \((\+\d+\.\d%) bias, (\d+\.\d%) WAPE against (\d+\.\d%)\)/, fmtSignedPct(f['foldBias.ensemble.F7']), fmtPct(f['foldWape.ensemble.F7']), fmtPct(f['foldWape.dhr.F7'])],
      [/F5 \(bias (-\d+\.\d%)\) and over-forecasts F2 and F4 \((\+\d+\.\d%) and (\+\d+\.\d%)\)/, fmtSignedPct(f['foldBias.hw.F5']), fmtSignedPct(f['foldBias.hw.F2']), fmtSignedPct(f['foldBias.hw.F4'])],
      [/only (\d+) of the (\d+) US federal holiday dates/, String(f['holidays.closed']), String(f['holidays.total'])],
      [/The test windows hold (\d+) zero-call days/, String(f['zeroCallDays'])],
      [/lowers daily WAPE by (\d+\.\d) to (\d+\.\d) points: DHR to (\d+\.\d%), the ensemble to (\d+\.\d%)/, Math.min(...openGain).toFixed(1), Math.max(...openGain).toFixed(1), fmtPct(f['open.dhr']), fmtPct(f['open.ensemble'])],
      [/daily WAPE between (\d+\.\d%) and (\d+\.\d%) for its largest queue/, `${Math.min(...sample).toFixed(1)}%`, `${Math.max(...sample).toFixed(1)}%`],
      [/with daily WAPE from (\d+\.\d%) to (\d+\.\d%)\./, fmtPct(Math.min(...dailyAll)), fmtPct(Math.max(...dailyAll))],
      [/averages from (\d+) to (\d+) agent-queue calls a day over the test period \(October \d+ counted from (\d+) October\)/, fmtInt(f['test.monthMin']), fmtInt(f['test.monthMax']), String(Number(testFrom[2]))],
      [/covers only (\d+\.\d%) of points/, fmtPct(f['coverage.interval'])],
      [/April 2020 averages (\d+) agent-queue calls a day against (\d+) in April 2019/, fmtInt(f['csv.apr2020']), fmtInt(f['csv.apr2019'])],
    ]

    const covered = new Array<boolean>(prose.length).fill(false)
    for (const [re, ...expected] of pins) {
      const matches = [...prose.matchAll(new RegExp(re.source, 'gd'))]
      expect(matches.length, `${re} should match the prose once`).toBe(1)
      const m = matches[0]
      expect(m.slice(1), String(re)).toEqual(expected)
      for (let g = 1; g < m.length; g++) {
        const [a, b] = m.indices![g]!
        covered.fill(true, a, b)
      }
    }

    // Qualitative claims backed by the evidence file.
    expect(ev.timestamps2023.monthsOpeningAt0800, 'every month of 2023 opens at 08:00').toBe(ev.timestamps2023.weekdayMonths)
    expect(ev.timestamps2023.handledAt0700, 'no 2023 weekday calls handled at 07:00').toBe(0)
    expect(r.negativeGapDays, 'daily gap never negative').toBe(0)
    expect(ev.talk.averageIsFloorRows, 'AVERAGE_TALK_TIME is the floor on all rows').toBe(ev.talk.rowsWithHandled)
    expect(o.daytimeGapDatesWeekendOrClosed, 'daytime gaps all on weekends or closed days').toBe(o.daytimeGapDates)

    // Every other number must be a fixed constant (page size, licence
    // version, thresholds, slot counts), a date, time, year or label.
    let masked = prose.replace(/\]\([^)]*\)/g, (s) => ' '.repeat(s.length))
    for (const constant of [
      '2,000 rows at a time', 'version 1.0', 'Canada 2.0', 'clause 4', 'clause 7', 'layer 0', 'Halifax 311', '311 contact centre',
      '311 Call Volumes', '48 values', '48 slots', '100 or more handled', '90% of open days', '20 or more nonzero', 'fewer than 20% odd',
      '28-day horizon', ':00 or :30', 'COVID-19','8 folds of 28 days', 'about 2 seconds', 'the 8 weeks before', 'have `OFFERED` 0', 'get `aht` 0',
    ]) {
      masked = masked.split(constant).join(' '.repeat(constant.length))
    }
    masked = masked
      .replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
      .replace(/\d{4}-\d{2}-\d{2}/g, (s) => ' '.repeat(s.length))
      .replace(/\b\d{1,2}:\d{2}\b/g, (s) => ' '.repeat(s.length))
      .replace(/\b(19|20)\d{2}\b/g, (s) => ' '.repeat(s.length))
      .replace(/\b\d+(st|nd|rd|th)\b/g, (s) => ' '.repeat(s.length))
      .replace(/\bF\d\b/g, (s) => ' '.repeat(s.length))
      .replace(/\b\d+-\d+\b/g, (s) => ' '.repeat(s.length))
    const unpinned = [...masked.matchAll(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?%?/g)]
      .filter((m) => !covered.slice(m.index, m.index + m[0].length).every(Boolean))
      .map((m) => `${m[0]} in "${prose.slice(Math.max(0, m.index - 40), m.index + 20)}"`)
    expect(unpinned).toEqual([])
  })

  it('pins the README headline figures', () => {
    const daily = (m: 'dhr' | 'ensemble' | 'equal') => fmtPct(report.score(m, 'daily').wape)
    const halifax = section(readme, '## Real data: Halifax 311')
    expect(halifax).toContain(
      `Daily WAPE over 8 folds x 28 days: DHR ${daily('dhr')}, ensemble ${daily('ensemble')}, equal-weight blend ${daily('equal')}.`,
    )
    expect(halifax).toContain(
      `without the ${f['zeroCallDays']} zero-call test days, ensemble daily WAPE is ${fmtPct(report.dailyWapeOpenDays.ensemble)}.`,
    )
    for (const p of percents(halifax)) expect(computed, p).toContain(p)
  })
})
