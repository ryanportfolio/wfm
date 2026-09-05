# Design: WFM forecasting and staffing tool

Portfolio tool for a WFM analyst/manager. Demonstrates the competencies job posts name: volume forecasting with accuracy reporting, interval staffing requirements, scenario ("what-if") modeling, and queue strategy analysis. Research basis: [research.md](research.md).

## Module roadmap

1. **Forecast + staffing engine** (implemented): load interval history, forecast via comparable methods including a custom ensemble, backtest with WAPE/bias scorecard, convert to interval staffing via Erlang A/C with shrinkage and occupancy, live what-if levers.
2. **Capacity planner** (implemented): one queue, 13 editable demand weeks, attrition and one hiring class with training/ramp, productive FTE and paid cost.
3. **Queue strategy analyzer** (future): pooled vs split required-FTE comparison, arrival correlation, mix-factor stress.
4. **Intraday reforecast** (implemented): observed-prefix ratio reforecast and editable interval staffing. Skill routing and move optimization remain future work.

Named local project files connect the implemented modules. Capacity and intraday are planning tools with explicit assumptions, not scheduling or routing optimizers.

## Stack

- Vite + React + TypeScript, fully client-side. No backend: `npm install && npm run dev` runs it; the same build deploys as a static site (GitHub Pages/Vercel) for a live resume link.
- All math hand-implemented in `src/engine/` as pure TypeScript functions with unit tests (Vitest). No stats libraries: the implementations are the portfolio.
- Charts: Recharts (declarative, small API surface).
- Data and plans stay in browser memory until explicitly saved as local project JSON. Theme is in localStorage; staffing settings also round-trip through the URL hash. Forecasts, backtests and staffing share a Web Worker. Intraday uses a separate cancellable worker with a 10-second timeout. Where Worker is unavailable, engine calls fall back to the calling thread; that fallback has no interruptible timeout.

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

Single-page, six tabs matching the workflow: **Data** (upload/sample, cleaning report), **Forecast** (actual vs per-method overlay, horizon picker), **Accuracy** (scorecard table + bias chart), **Staffing** (interval requirement grid + what-if panel), **Capacity** (13-week supply/demand comparison), **Intraday** (observations and revised need). Header controls name, save and open projects. Tabs support keyboard navigation; charts have numeric tables. Dark-capable, every metric labeled with its WFM term (SL, ASA, occupancy, shrinkage) since the audience is WFM hiring managers.

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

## Verification bar

- Unit tests: Erlang B/C/A against published table values; Holt-Winters against a hand-computed small series; WAPE/MAPE/bias on toy vectors; profile shares sum to 1.
- Backtests report observed relative performance, including when a component beats the ensemble. The ensemble is not guaranteed to win on every dataset; compare it with components and equal weights.
- `npm run build` clean; README documents run steps.
