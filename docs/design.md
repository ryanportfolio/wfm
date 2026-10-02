# Design: WFM forecasting and staffing tool

Portfolio tool for a WFM analyst/manager. Demonstrates the competencies job posts name: volume forecasting with accuracy reporting, interval staffing requirements, scenario ("what-if") modeling, and queue strategy analysis. Research basis: [research.md](research.md).

## Module roadmap

1. **Forecast + staffing engine** (implemented): load interval history, forecast via comparable methods including a custom ensemble, backtest with WAPE/bias scorecard, convert to interval staffing via Erlang A/C with shrinkage and occupancy, live what-if levers.
2. **Capacity planner** (implemented): one queue, 13 editable demand weeks, attrition and one hiring class with training/ramp, productive FTE and paid cost.
3. **Queue strategy analyzer** (future): pooled vs split required-FTE comparison, arrival correlation, mix-factor stress.
4. **Intraday reforecast** (implemented): observed-prefix ratio reforecast and editable interval staffing. Skill routing and move optimization remain future work.
5. **Schedule builder** (implemented: engine and Schedule tab; project files do not store schedules yet): one-queue, one-day shifts with breaks and lunch built from shift templates against the Erlang requirement.

Named local project files connect the implemented modules except the schedule builder. Capacity and intraday are planning tools with explicit assumptions, not scheduling or routing optimizers; the schedule builder is a one-day heuristic, not a workforce scheduling system.

## Stack

- Vite + React + TypeScript, fully client-side. No backend: `npm install && npm run dev` runs it; the same build deploys as a static site (GitHub Pages/Vercel) for a live resume link.
- All math hand-implemented in `src/engine/` as pure TypeScript functions with unit tests (Vitest). No stats libraries: the implementations are the portfolio.
- Charts: Recharts (declarative, small API surface).
- Data and plans stay in browser memory until explicitly saved as local project JSON. Theme is in localStorage; staffing settings also round-trip through the URL hash. Forecasts, backtests and staffing share a Web Worker. Intraday calculations and schedule builds each run in their own cancellable worker with a 10-second timeout. Where Worker is unavailable, engine calls fall back to the calling thread; that fallback has no interruptible timeout.

Why not Python: gradient boosting is the only method that needs it, and the research (design section of research.md) shows the ensemble + DHR covariates capture most of the documented gain. A Python service can be added as a v2 experiment.

## Data model

Interval record (30-minute default, 15 supported):

```ts
interface IntervalRecord {
  ts: string;        // interval start, ISO local
  queue: string;     // queue/skill name; multi-queue from day one
  offered: number;   // contacts offered
  aht: number;       // average handle time, seconds
}
```

CSV columns `timestamp,queue,offered,aht`. Bundled sample dataset: generated, 2 years, 3 queues (voice-heavy public-sector shape: Monday peaks, post-holiday spikes, benefit-cycle bumps, intraday twin peaks), overdispersed negative-binomial noise, tagged holidays, a few injected outage outliers so the cleaning step has something to show.

Derived objects: `DailySeries` (per queue: date, total, aht-weighted), weekday interval profiles (per weekday: one share per interval, summing to 1; see `profiles.ts`), `ForecastResult` (per-method daily totals, banded ensemble daily points, intervalized ensemble), `BacktestReport` (per method x grain: WAPE, MAPE, bias), `StaffingGrid` (per interval: required bodies, scheduled after shrinkage, occupancy, predicted SL/ASA/abandon).

## Import integrity

CSV normalizes omitted zero seconds when checking queue/timestamp duplicates and rejects the whole duplicate file. Other invalid rows are reported and skipped. Numeric parsing rejects decimal overflow as well as negative and nonnumeric input. Project imports use stricter whole-file validation.

Completeness diagnostics count absent calendar dates inside each queue's own range, missing expected slots on dates that have rows, and explicit zero observations separately. A slot is expected when present on at least two dates and more than half of observed dates for that weekday. Sparse history can leave gaps undetected. Bounded examples avoid constructing huge missing-date arrays. Diagnostics do not infer an operating calendar or repair gaps: daily series still zero-fill absent days, and profiles use available records. Users must distinguish closures from missing observations before relying on results.

## Forecast engine

Pipeline per queue:

1. **Clean**: MAD-based outlier flags per (weekday, interval) cell; flagged cells replaced by cell median for fitting, listed in UI. US federal holidays tagged; holiday and holiday+1 handled as dummies (DHR) or exclusions (averages).
2. **Component models** on daily totals:
   - `seasonalMovingAverage`: trimmed mean of same weekday, last 8 weeks, recency weights.
   - `holtWinters`: additive, weekly seasonality (m=7), grid-searched alpha/beta/gamma on the training window.
   - `dhr`: ridge regression on Fourier pairs (weekly K=3, yearly K=2), linear trend, holiday/holiday-adjacent/weekday dummies.
3. **Custom ensemble "blend"**: weights per horizon bucket (1-3d, 4-14d, 15-28d) proportional to inverse rolling-origin WAPE of each component raised to a power; the power is picked from a small grid (1, 2, 4, 8, Infinity) by pooled inner blend WAPE, so the data decides how concentrated the blend is. Falls back to equal weights below minimum history. The inner-fold relative errors also calibrate an 80% prediction band per horizon bucket (empirical 10th/90th percentiles), drawn around the ensemble daily forecast.
4. **Intervalize**: recency-weighted day-of-week profiles from cleaned history map daily totals to intervals. AHT forecast: recency-weighted same-weekday interval means.
5. **Backtest**: rolling origin (default 8 folds, 28-day horizon), scoring every component and the ensemble at interval/daily/weekly grain: WAPE, MAPE, bias. Scorecard rendered in UI; the ensemble must prove itself on the loaded data, not by assertion.

## Staffing engine

- Erlang C: stable Erlang B recursion, SL/ASA/occupancy outputs; the agent search starts at `max(1, ceil(A))` (N > A is required for stability).
- Erlang A: birth-death steady-state solve with patience theta; outputs SL, ASA, abandonment; dual-target staffing (SL and max abandon). Abandonment sheds load, so targets can be feasible below `ceil(A)`; after the upward scan finds a feasible N, a binary search finds the true minimum down to 1.
- Gross-up: `scheduled = bodies / (1 - shrinkage)`; occupancy cap adds agents when `A/N` exceeds the cap even at met SL.
- Inputs per scenario: SL target (X% in Y s), patience mean, shrinkage, occupancy cap, interval length.

Interactive staffing rejects effective offered load above 1,000 Erlangs before a queue solve, where load = contacts × AHT seconds / concurrency / interval seconds. Required-agent search stops at 2,000 on-contact agents with an error if targets remain unmet. Fixed-staff projection checks the same load limit and a 2,000 on-contact-agent limit before recursion. Intraday has the tighter limits below.

Each Erlang A solve also limits uniformization to 5 million waiting-phase updates. Estimated work is `K × ceil(a + 12√a + 200)`, where `K` is the retained waiting-phase count and `a = (N / AHT + K / patience) × target`; all times are seconds. Excessive or nonfinite estimates produce an error before the time-step loop. Fractional-second inputs remain supported when their work fits the budget. This catches unit mistakes such as an AHT of `0.00000001` seconds even at very low offered load.

For an over-budget solve, the eventual answered fraction can supply service level only when `P(wait) × exp(-target / patience) ≤ 1e-12`. A caller still waiting at the target must have survived its independent exponential patience clock, so this bounds the omitted late-service probability and the absolute service-level error. Other metrics and ordinary calculations are unchanged; inputs are never clamped. These are practical per-solve bounds, not statistical validity or whole-grid latency guarantees.

## What-if levers

Sliders recomputing the staffing grid live: volume +/-30%, AHT +/-20%, shrinkage 0-50%, SL target, patience, abandonment cap, occupancy cap, chat concurrency, Erlang A/C mode. Side-by-side scenario A/B with per-day deltas (scheduled FTE-hours, peak heads, SL, cost). A fixed-staff mode projects service at a given head count instead of solving for one. Optional cost-per-hour rate prices scheduled FTE-hours; forecast, scorecard, and staffing tables export as CSV.

## UI layout

Single-page, seven tabs matching the workflow: **Data** (upload/sample, cleaning report), **Forecast** (actual vs per-method overlay, horizon picker), **Accuracy** (scorecard table + bias chart), **Staffing** (interval requirement grid + what-if panel), **Capacity** (13-week supply/demand comparison), **Intraday** (observations and revised need), **Schedule** (one-day shift build with coverage chart). Header controls name, save and open projects. Tabs support keyboard navigation; charts have numeric tables. Dark-capable, every metric labeled with its WFM term (SL, ASA, occupancy, shrinkage) since the audience is WFM hiring managers.

## Capacity model

Demand contains exactly 13 weekly productive-FTE assumptions. A productive FTE uses the entered paid workweek, which must be positive and at most 168 hours. Explicit seeding sums default-target required on-contact hours (Erlang A, 80% in 20 seconds, 120-second patience, 90% occupancy cap; two concurrent chats for chat queues) over complete seven-calendar-day blocks and divides by those weekly hours. With horizons of 7, 14 or 28 days this seeds 1, 2 or 4 weeks. Later weeks repeat the last complete week as labeled, editable assumptions; there is no validated 13-week forecast. Changes to forecast/scenario inputs do not automatically reseed saved demand.

Existing headcount is available in week 1; weekly attrition begins at the start of week 2. Hires arrive and are paid in their chosen start week, then face attrition every later week, including training.

Full training weeks provide no productive supply. Ramp weeks supply 1/N, 2/N, through 100% of surviving hires; zero ramp means full productivity immediately after training. Both cohorts use the same attrition rate, and fractional expected heads are retained.

Productive supply = (surviving existing heads + surviving hires × productivity) × (1 − shrinkage). Demand uses on-contact requirements, so shrinkage is applied only to supply. Paid cost = surviving paid heads × paid hours per week × hourly cost, including trainees. Cost excludes overtime, benefits and recruitment fees. Baseline/proposal first-shortage weeks, weekly balances and cumulative cost use unrounded arithmetic. Each queue has separate drafts, source labels and optional seed dates; chart, table and CSV use the same weekly model.

## Portable projects

The current schema is `wfm-project`, version 2. Root fields are `schema`, `version`, `name`, `records`, `sourceLabel`, `queue`, `horizon`, `staffing`, `capacityByQueue` and `intradayByQueue`. Staffing includes scenario A, optional retained B, comparison visibility and cost text. Capacity and intraday retain blank draft inputs. Invalid populated capacity values, scheduled staffing and observed actuals prevent saving. Inactive future actuals retain bounded draft text and are numerically validated when their interval enters the observed prefix. Limits are 64 MB and 500,000 interval rows.

The complete object, exact fields, finite numbers, dates, duplicates and queue references are validated before replacing React state. Failed imports preserve current work; the most recent requested import wins even if an older read finishes later. Exact version 1 files migrate by adding an empty intraday map; unknown versions or extra legacy fields fail.

Forecasts and grids are recomputed, not stored. Project settings override the initial staffing URL. Theme remains a browser preference. There is no backend, upload or automatic project persistence; closing without saving loses edits.

## Intraday model

For the chosen forecast day, the cutoff is a count of elapsed intervals. Only that prefix contributes actuals or the ratio. Every elapsed interval needs a value; zero is valid, blank is incomplete. Future draft actuals are ignored until their interval enters the prefix.

Revised observed demand equals actuals. Remaining demand = original baseline × (sum of elapsed actuals / sum of elapsed baseline). If the denominator is zero, remaining baseline is retained with a visible explanation. No observed intervals also retains baseline.

The original forecast volume stays the baseline. Scenario A supplies service targets, AHT adjustment, shrinkage and chat concurrency for both comparisons; scenario volume adjustments do not modify baseline. Positive demand requires positive AHT. Scheduled heads default to zero and can vary per interval. Service projections use floor(scheduled heads × (1 − shrinkage)); required bodies are on-contact requirements. Intraday CSV preserves exact entered scheduled-head values so export rounding cannot change that whole-body floor.

Inputs support at most 48 half-hour intervals starting at :00 or :30, 100,000 contacts and 500 scheduled heads per interval, and 100 effective Erlangs. AHT is at most 7,200 seconds; concurrency is 1 to 10; shrinkage is 0 to 80%; SL is 50 to 99% in 1 to 300 seconds; patience is 10 to 600 seconds; occupancy cap is 50 to 100%; abandonment cap, when used, is 1 to 100%. Out-of-range inputs fail clearly. Intraday intentionally rejects 15-minute forecasts, while staffing and capacity seeding share interval-duration inference for 15-minute data.

Editing, switching day/queue or leaving the Intraday tab cancels the intraday worker. Hidden panels do not launch jobs; reopening calculates with current settings. Changed inputs hide stale results. Each job has a 10-second timeout. Inputs persist by queue/day in project files and reset on CSV/sample replacement. Erlang results are per-interval steady-state approximations: no waiting callers or backlog carry forward, and chat concurrency approximates faster service rather than explicit simultaneous sessions. This can overstate service after an understaffed stretch.

## Schedule builder

`src/engine/schedule.ts` builds shifts for one queue and one day. Inputs are the per-interval on-phone requirement from the staffing grid (0 to 500 agents per interval; 15- or 30-minute intervals, at most 24 hours from a day start on a 15-minute boundary), unplanned shrinkage (0 to 80%, default 15%) and 1 to 12 shift templates. Times are wall-clock: interval i starts i × interval length after the day start, with no daylight-saving adjustment, so a day containing a clock change is treated as if every interval had its nominal length.

A template sets the time on site, a start window (earliest, latest and step, in minutes after day start), up to four paid breaks kept in template order, an optional paid or unpaid lunch, a minimum gap and an optional shift cap. Each break and lunch has a duration and a window for its start, measured from shift start. The minimum gap applies between consecutive activities and between shift start or end and any activity. All times are multiples of 15 minutes. Paid minutes are the time on site minus an unpaid lunch. A shift whose latest start would run past day end is rejected, so no shift runs overnight. A template whose breaks and lunch cannot fit their windows, order and gaps fails validation before any build. A schedule holds at most 500 shifts.

Coverage uses 15-minute slots. An agent counts in every slot of the shift except break and lunch slots. A 30-minute interval's coverage is the mean of its two slots, so a 15-minute break removes half an agent. Target = required / (1 - unplanned shrinkage). Breaks and lunch are placed explicitly, so unplanned shrinkage must exclude them.

Cost, in agent-slots (one agent for 15 minutes), is 10 × under-coverage + 1 × over-coverage + 0.01 × paid slots, with under and over measured per interval against target. The result lists each shift, per-interval rows (target, coverage, over, under) and under, over and paid agent-hours.

The builder first adds shifts greedily: each step evaluates every template and start, places breaks and lunch left to right at the feasible offsets where removing the agent costs least, and adds the single shift that lowers cost most. It stops when no shift lowers cost or a cap is reached. Local search then tries random moves from a seeded generator: move a start one step, move one activity within its window, switch to another template, drop a shift or add one. Only strict cost improvements are kept, and coverage changes are evaluated incrementally. A move-attempt budget (default 20,000) and an optional deadline bound the run. The same inputs and seed give the same schedule unless the deadline cuts the search short. A day of 48 half-hour intervals with 3 templates and a peak target of 105 agents took about 70 ms in Node on a desktop; 12 templates at the 500-shift cap on 96 quarter-hour intervals took about 1.1 seconds.

Results are heuristic, not proven optimal. The builder does not model named agents, days off, weekly hours, agent preferences, skills or multiple queues, or labor-law rules. Requirements are Erlang steady-state values per interval, so backlog carried between intervals is not represented.

The Schedule tab uses the selected queue and one forecast day. The requirement is scenario A's on-phone `required` per interval, solved with the same settings and volume and AHT adjustments as the Staffing tab; Staffing-tab shrinkage is not applied, because unplanned shrinkage (default 15%: absence, coaching, meetings) replaces it. The template editor takes clock times for start windows, h:mm offsets from shift start for break and lunch windows, and whole minutes for lengths, start step and minimum gap. Until edited, the three default templates (full-time 8.5 hours on site with two paid 15-minute breaks and an unpaid 30-minute lunch, part-time 4 hours with one break, ten-hour 10.5 hours on site with two breaks and an unpaid lunch) take their start windows from the day's open hours, the first through last interval with forecast contacts (the whole day when it has none). When the open hours are at least a shift long, starts run from opening to the last start that ends at closing, every 30 minutes, or every 15 when only that reaches the last start. When they are shorter, the window widens within the day so one shift spans all of them. A template longer than the day is left out, and if none fits, one break-free shift as long as the day replaces them, so untouched defaults always pass validation. Shifts cannot cross midnight: for a queue with contacts at 00:00 or up to 24:00, the tab says so, and the hours next to midnight can only be covered by shifts starting at 00:00 or ending at 24:00. Forecasts with intervals other than 15 or 30 minutes, such as hourly data, show a plain message instead of the editor. Format errors and engine validation errors appear inline on the template they concern, in polite live regions so typing does not interrupt a screen reader, and Build stays disabled until they are fixed.

Build runs the requirement solve and the builder in a cancellable worker with a 10-second timeout and seed 1; where Worker is unavailable it runs on the calling thread. The job has an 8-second budget counted from the moment Build posts it, so worker startup, message transfer and the requirement solve come out of it and the builder gets what remains; a slow build still returns before the timeout, flagged when the budget cut the search short. Changing any input, the day or scenario A cancels a running build and hides the previous result until Build is pressed again. Output: totals (shifts by template, paid, understaffed and overstaffed agent-hours, first-pass and final cost, move attempts), a coverage chart of scheduled on-phone agents against target and requirement with over and under shading, the same rows as a numeric table, and the shift list in clock times. Two CSV downloads hold the shift list and the interval coverage; a template name starting with =, +, -, @, tab or carriage return gets an apostrophe prefix so spreadsheets do not run it as a formula. Schedule inputs persist per queue for the session and reset when a CSV, sample or project loads; project files do not store them yet.

## Verification bar

- Unit tests: Erlang B/C/A against published table values; Holt-Winters against a hand-computed small series; WAPE/MAPE/bias on toy vectors; profile shares sum to 1.
- Backtests report observed relative performance, including when a component beats the ensemble. The ensemble is not guaranteed to win on every dataset; compare it with components and equal weights.
- Schedule builder: hand-checked cases plus property tests over random seeds and templates, including infeasible templates checked against an independent brute-force feasibility search, start steps up to 120 minutes and minimum gaps up to 60 minutes. Each feasible case recounts coverage and cost from the shifts, checks every template rule, checks that local search never raises cost and that the first-pass cost equals a zero-iteration build, and reruns for determinism.
- `npm run build` clean; README documents run steps.
