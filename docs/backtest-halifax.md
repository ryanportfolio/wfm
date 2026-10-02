# Backtest on real data: Halifax 311 call volumes

The sample dataset is generated, so its accuracy figures show how the engine behaves on data with known structure. This page runs the same engine, with the same options as the Accuracy tab, on 6.4 years of real half-hourly call volumes from the Halifax Regional Municipality (HRM) 311 contact centre.

## Source and licence

- Dataset: [311 Call Volumes](https://data-hrm.hub.arcgis.com/datasets/HRM::311-call-volumes/about), Halifax Regional Municipality open data (ArcGIS feature service `311_Call_Volumes`, layer 0). Fetched 2026-10-01: 148,821 rows, 2017-01-01 to 2026-09-26.
- Licence: [Open Government Licence - Halifax](https://data-hrm.hub.arcgis.com/pages/open-data-licence), version 1.0, based on the Open Government Licence - Canada 2.0.
- Required attribution, quoted from clause 4 of the licence:

  > Contains information licenced under the Open Government Licence—Halifax.

- `public/data/halifax-311.csv` is a modified, derived version of the source: fields are recombined, omitted intervals are zero-filled and dates after 2023-05-22 are dropped, as described below. Errors introduced by these steps are this project's, not HRM's.
- Halifax Regional Municipality does not endorse this project or its use of the data (licence clause 7).

## How the CSV is built

`node scripts/fetch-halifax-311.mjs` pages the feature service 2,000 rows at a time (`resultOffset`, ordered by `ObjectId`), caches the raw JSON under `.tmp/halifax-311/raw/`, and writes `public/data/halifax-311.csv`. Rerunning it reuses the cache; `--refresh` downloads again. On every run the script checks the evidence for both cutoffs below and stops if the source no longer matches it.

Source fields per row: `CALL_DATE`, `MILITARY_HOUR`, `INTERVAL` (for example `09:30 AM - 10:00 AM`), `OFFERED`, `HANDLED`, `ABANDONED`, `PROCESSED_IN_IVR`, `TOTAL_TALK_TIME`, `AVERAGE_TALK_TIME`. No field has nulls or negative values. HRM's [2018 metadata sheet](https://hrm.maps.arcgis.com/sharing/rest/content/items/86718144357c438b9cbce1557aa77497/data) (PDF) defines them: `OFFERED` is calls received by the contact centre, `HANDLED` calls handled by an agent, `ABANDONED` calls abandoned by the customer, `PROCESSED_IN_IVR` calls where customers got what they needed from the IVR's messages or information mailboxes, and both talk-time fields are seconds the customer spoke with an agent. It does not say whether `ABANDONED` includes callers who hung up in the IVR.

### Timestamps

The metadata sheet says each `CALL_DATE` is a local date stored as a UTC timestamp at 04:00 (midnight Atlantic Standard Time). The current data does not match that convention: every value is at 07:00 UTC (98,061 rows) or 08:00 UTC (50,760 rows), switching on the North American daylight-saving dates, which is local midnight in US Pacific time. Either way the UTC calendar date is the source's local date, and the weekday pattern confirms it (Saturdays and Sundays are the low days). `INTERVAL` takes 48 values starting on :00 or :30, and its start hour matches `MILITARY_HOUR` on every row. In 2023, weekday handled calls start in the 08:00 slot in every month, with none at 07:00; a fixed UTC or standard-time clock would move that opening slot by an hour between winter and summer, so the hours are Halifax wall-clock time with daylight saving. Each row becomes `YYYY-MM-DDTHH:MM`, the interval start in local time.

### Two source defects, two cutoffs

The source has two defects that begin partway through it. The CSV corrects neither: it stops on 2023-05-22, the day before the earlier one.

**Hour shift from 2024-07-17.** From that date the hour field runs 7 hours late in summer and 8 in winter: weekday handled calls start in the 15:00 slot during daylight saving time and the 16:00 slot in standard time, against 08:00 before. Up to 2024-07-16 the handled-call-weighted mean hour of every day with 100 or more handled calls lies between 11.0 and 16.5. On 2024-07-17 handled calls start at 14:30, the mean hour is 19.7 and the day has only 29 rows.

**Double counting from 2023-05-23.** From that date to the hour shift, `HANDLED`, `ABANDONED` and `TOTAL_TALK_TIME` are doubled on most days. Before it, 29% to 74% (median 54%) of each day's nonzero values in those three fields are odd, over 2,324 days. From 2023-05-23 to 2024-07-16, 395 of 407 open days have 0% to 7.5% odd values, which is what doubling every count produces. The other 12 days have 46% to 65%, the normal spread, and carry 35% to 57% of the volume of the same weekday in the three weeks either side. `OFFERED` and `PROCESSED_IN_IVR` keep their normal mix of odd and even values, but `OFFERED` equals the doubled `HANDLED + ABANDONED` plus `PROCESSED_IN_IVR` exactly on 6,024 of the window's 17,454 rows, so it is inflated as well. Uncorrected, agent-side volume doubles overnight on 2023-05-23 and stays there; halving the doubled days would bring January 2024 to 590 agent-queue calls a day, against 561 in January 2023.

**Why cut rather than correct.** Neither defect is documented by HRM, so any correction rests on inference. Halving needs a per-day guess at which days are doubled, and 12 days in the window are not; shifting needs a per-day guess at the offset, with a partial day at the boundary. Either guess would sit in every row of the most recent period, which is the part the backtest scores. Cutting keeps every value in the CSV as published. The cost is the last 40 months of the source.

The script checks both defects on every run: every day before 2024-07-17 with 100 or more handled calls must be centred between 10:00 and 17:00 and 2024-07-17 must not be; at least 90% of open days from 2023-05-23 to the hour shift, including the first, must show the doubled pattern; and no day up to 2023-05-22 with 20 or more nonzero values may have fewer than 20% odd values.

### Offered: answered plus abandoned

The app's `offered` is demand for agents. The source's `OFFERED` also counts calls completed in the IVR, so the CSV uses `HANDLED + ABANDONED`: calls that reached the agent queue and were answered or abandoned.

Reconciliation over the kept range, 2017-01-01 to 2023-05-22 (98,354 rows):

- `OFFERED = HANDLED + ABANDONED + PROCESSED_IN_IVR` exactly on 44,579 rows (45.3%) and within one call on 68,658 (69.8%). `OFFERED` is the smaller side on 6,464 rows, consistent with calls that start in one interval and finish in the next.
- Summed over the period, 99,767 calls (3.9% of 2,533,211 offered) have no recorded outcome. Per day the gap runs from 1.7% (5th percentile) through 3.8% (median) to 9.8% (95th percentile) and is never negative.
- Between 08:00 and 19:59 the gap is 76,175 calls: 14.0% of the IVR-completed calls in those hours and 4.6% of answered plus abandoned. Outside those hours it is 23,592 calls: 12.5% of IVR-completed calls but 60.0% of answered plus abandoned. The gap keeps a steady ratio to IVR traffic, not to agent traffic, so the CSV does not count it as agent demand.
- `OFFERED - PROCESSED_IN_IVR` would give 2,533,211 - 734,409 = 1,798,802 calls; `HANDLED + ABANDONED` gives 1,699,035, 5.5% fewer.

### AHT is talk time

`aht` is `TOTAL_TALK_TIME / HANDLED` in seconds. `AVERAGE_TALK_TIME` equals the floor of that ratio on all 93,334 source rows with handled calls, which fixes the unit as seconds; the volume-weighted mean in the CSV is 231 seconds. Talk time excludes hold and after-call work, so it understates handle time and any staffing figure built on it understates workload.

An interval with agent-queue calls but no recorded talk time (709 rows: abandoned calls only, or handled calls with zero talk time; mostly early morning and late evening) has no talk time to divide; it takes the day's mean talk time per handled call so the row passes the app's rule that positive volume needs positive AHT. Intervals with no agent-queue calls get `aht` 0.

### Omitted intervals

The source omits intervals rather than writing zero rows: only 294 of the 98,354 kept rows have `OFFERED` 0, and a day has 37 to 47 rows (5th to 95th percentile). Of the 13,630 omitted day-slots, 13,502 (99.1%) fall between 21:00 and 06:59. The rows that are present in those night slots average 0.63 agent-queue calls, 69.7% of them have none, and night slots carry 1.2% of agent-queue calls. The script therefore writes every omitted slot as zero calls, except on 2019-05-26 (Sunday): that day has 19 rows and none for the 04:30 to 17:30 slots, while the centre was open. Its 29 missing slots stay missing, so the Data tab's completeness report lists them as missing expected slots. 9 other dates each miss 1 slot between 08:00 and 19:59, all on weekends or a closed holiday; those are zero-filled.

There are no missing dates. Days when the centre was closed (for example 2023-01-01) have rows with zero agent-queue calls and stay in the data as zeros. Daylight-saving days get no special treatment: the source uses the same 48 slots on every date, including 02:00 and 02:30 rows on spring-forward days when that local hour does not exist, and the night slots involved hold almost no agent-queue calls.

### Output

One queue, `halifax-311`: the source has no queue or line breakdown. 111,955 rows (48 slots for each of 2,333 days, less the 29 outage slots), 2017-01-01 to 2023-05-22, 3.97 MB. The file parses through the app's own `parseCsv` with zero errors.

## Method

`npx vite-node scripts/halifax-backtest.ts` prints every table below; `scripts/halifaxReport.ts` computes them through the app's own entry points:

- `parseCsv`, the Upload CSV path.
- `analyzeDataQuality`, the Data tab completeness report.
- `runForecast` with a 28-day horizon, for the Data tab cleaning report and the ensemble weights.
- `runBacktest` with 8 folds of 28 days, the Accuracy tab's options: each fold re-cleans and re-fits on all data before its origin, and scores against the raw actuals.
- A fold-by-fold replay of the daily forecasts, checked against `runBacktest`, for per-fold bias and for scoring without zero-call days.

`scripts/halifaxReport.test.ts` recomputes the tables and fails if this page or the README quote a figure that no longer matches. The whole report takes about 2 seconds.

## Results

### Data

- Rows parsed: 111,955, parse errors: 0
- Range: 2017-01-01 to 2023-05-22 (2,333 days)
- Agent-queue calls: 1,699,035

### Completeness (Data tab)

| Missing dates | Missing expected slots | Explicit zero rows |
|---:|---:|---:|
| 0 | 29 | 44,168 |

### Cleaning report (Data tab, full history)

- Interval outliers: 1,317
- Daily outliers: 9
- US federal holiday dates in range: 80, of which zero-volume (closed): 6
- Holiday mode: open on holidays

### Scorecard (8 folds x 28 days, test days 2022-10-11 to 2023-05-22)

| Method | WAPE interval | WAPE daily | WAPE weekly | MAPE interval | MAPE daily | MAPE weekly | Bias interval | Bias daily | Bias weekly |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SMA | 28.6% | 22.0% | 19.4% | 43.1% | 26.2% | 21.8% | +5.0% | +5.0% | +5.0% |
| Holt-Winters | 32.2% | 26.8% | 23.0% | 52.7% | 40.1% | 24.7% | +7.0% | +7.0% | +7.0% |
| DHR | 24.7% | 17.3% | 12.5% | 35.8% | 24.0% | 12.7% | -4.5% | -4.5% | -4.5% |
| Equal-weight blend | 25.5% | 18.6% | 15.8% | 39.4% | 24.0% | 17.5% | +2.5% | +2.5% | +2.5% |
| Ensemble | 25.4% | 18.1% | 13.8% | 37.7% | 24.0% | 14.6% | -0.5% | -0.5% | -0.5% |

MAPE coverage (points with nonzero actuals): interval 45.6%, daily 98.7%, weekly 100.0%.

### Daily WAPE per fold (F1 = most recent)

| Method | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SMA | 15.2% | 21.5% | 18.6% | 12.0% | 13.9% | 50.7% | 44.5% | 11.8% |
| Holt-Winters | 27.6% | 29.7% | 17.6% | 29.9% | 55.1% | 27.8% | 18.2% | 14.0% |
| DHR | 15.1% | 17.3% | 18.6% | 14.3% | 15.8% | 28.4% | 13.7% | 17.5% |
| Equal-weight blend | 16.6% | 14.6% | 17.3% | 13.2% | 27.1% | 33.4% | 22.2% | 11.3% |
| Ensemble | 14.5% | 17.4% | 18.6% | 13.9% | 15.8% | 28.9% | 27.2% | 13.0% |

Test windows: F1 2023-04-25 to 2023-05-22; F2 2023-03-28 to 2023-04-24; F3 2023-02-28 to 2023-03-27; F4 2023-01-31 to 2023-02-27; F5 2023-01-03 to 2023-01-30; F6 2022-12-06 to 2023-01-02; F7 2022-11-08 to 2022-12-05; F8 2022-10-11 to 2022-11-07.

### Mean daily WAPE by lead time

| Method | Days 1-7 | Days 8-14 | Days 15-28 |
|---|---:|---:|---:|
| SMA | 17.9% | 17.8% | 27.1% |
| Holt-Winters | 26.6% | 35.9% | 41.1% |
| DHR | 22.3% | 20.4% | 23.2% |
| Equal-weight blend | 18.0% | 19.0% | 23.1% |
| Ensemble | 21.0% | 19.0% | 23.1% |

### Ensemble weights fitted on the full history (Forecast tab, 28-day horizon)

| Horizon | SMA | Holt-Winters | DHR |
|---|---:|---:|---:|
| 1-3d | 15% | 65% | 21% |
| 4-14d | 67% | 6% | 27% |
| 15-28d | 28% | 9% | 63% |

### Daily bias per fold (F1 = most recent)

| Method | F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SMA | +7.1% | -15.7% | -8.9% | -0.9% | -13.4% | +50.7% | +44.5% | -3.7% |
| Holt-Winters | +24.3% | +28.9% | -2.6% | +29.9% | -55.1% | +15.1% | +11.6% | +5.1% |
| DHR | -1.1% | -10.5% | -5.9% | +0.8% | -12.9% | +20.2% | +3.3% | -17.5% |
| Equal-weight blend | +10.1% | +0.9% | -5.8% | +9.9% | -27.1% | +28.6% | +19.8% | -5.4% |
| Ensemble | +2.0% | -11.5% | -5.9% | +1.8% | -12.9% | +20.3% | +26.0% | -11.7% |
| Actual calls a day | 623 | 670 | 614 | 529 | 580 | 430 | 564 | 797 |
| Calls a day, 8 weeks before origin | 642 | 572 | 555 | 505 | 497 | 680 | 859 | 805 |

### Daily WAPE without the 3 zero-call test days

| Method | All test days | Zero-call days removed |
|---|---:|---:|
| SMA | 22.0% | 21.1% |
| Holt-Winters | 26.8% | 26.1% |
| DHR | 17.3% | 16.6% |
| Equal-weight blend | 18.6% | 17.8% |
| Ensemble | 18.1% | 17.4% |

Zero-call test days: 2022-12-25, 2023-01-01, 2023-05-22.

## Reading the results

Dynamic harmonic regression (DHR) has the lowest WAPE at every grain: 24.7% interval, 17.3% daily, 12.5% weekly. The ensemble is second at every grain (25.4%, 18.1%, 13.8%) and the equal-weight blend third (25.5%, 18.6%, 15.8%), so the fitted weights beat a plain average, by 0.1 points at interval grain and 2.0 at weekly grain, without matching DHR. The ensemble has the smallest bias, -0.5%, against -4.5% for DHR. Daily MAPE ties at 24.0% for DHR, the equal-weight blend and the ensemble.

The seasonal moving average (SMA) is fourth overall (22.0% daily WAPE) but is the most accurate method for the first two weeks (17.9% in days 1-7, 17.8% in days 8-14) and falls to 27.1% in days 15-28. The ensemble trails it early (21.0% in days 1-7). The weights fitted on the full history give Holt-Winters 65% of the 1-3 day blend, and Holt-Winters is the weakest method at every lead time here (26.6% in days 1-7, 41.1% in days 15-28), which is consistent with the ensemble trailing SMA and the equal-weight blend in week one.

Two folds drive SMA's result. In F7 and F6 it over-forecasts by +44.5% and +50.7%: the 8 weeks before those origins averaged 859 and 680 calls a day, while the test windows averaged 564 and 430. SMA weights recent weeks, so it carries an autumn high into November and the December low. DHR, which models yearly seasonality, stays closer (+3.3% and +20.2%). The ensemble does worse than DHR in F7 (+26.0% bias, 27.2% WAPE against 13.7%) because its weights for that fold still lean partly on SMA. Holt-Winters under-forecasts the January fold F5 (bias -55.1%) and over-forecasts F2 and F4 (+28.9% and +29.9%).

Closures have a small effect in this window. The engine's holiday calendar is US federal; only 6 of the 80 US federal holiday dates in the range are closed days in this data, so the cleaning step concludes the queue stays open on holidays and forecasts every closure as a normal day. The test windows hold 3 zero-call days. Removing them lowers daily WAPE by 0.7 to 0.9 points: DHR to 16.6%, the ensemble to 17.4%.

The sample data gives much lower errors: the README quotes daily WAPE between 7.9% and 11.3% for its largest queue, with DHR best and the ensemble second. Halifax keeps that order at the top, with daily WAPE from 17.3% to 26.8%. The generated sample follows the engine's own holiday calendar; this queue has level swings between seasons, closures the engine does not know about, and calendar-month averages from 455 to 834 agent-queue calls a day over the test period (October 2022 counted from 11 October), so half-hour counts are small and noisy. MAPE at interval grain covers only 45.6% of points because night intervals are mostly zero.

## Caveats

- `aht` is talk time per answered call. It excludes hold and after-call work, so staffing built on it understates workload.
- Offered is answered plus abandoned. IVR-completed calls and the 3.9% of offered calls with no recorded outcome are excluded.
- Data ends at 2023-05-22 because of the double counting that starts the next day; the hour shift from 2024-07-17 would have cut it later. The last 40 months of the source are not used.
- Omitted source intervals are zero-filled except on the 2019-05-26 outage day, which stays missing.
- One queue only.
- The training data spans the COVID-19 period without adjustment; for example, April 2020 averages 605 agent-queue calls a day against 749 in April 2019.
- The engine uses US federal holidays; Halifax closures in the test windows are forecast as open days.
- The field definitions date from 2018 and do not cover the double counting, the hour shift, the timestamp convention in use now, or the calls with no recorded outcome; those readings come from the checks above.
