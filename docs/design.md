# Design: WFM forecasting and staffing tool

Portfolio tool for a WFM analyst/manager. Demonstrates the competencies job posts name: volume forecasting with accuracy reporting, interval staffing requirements, scenario ("what-if") modeling, and queue strategy analysis. Research basis: [research.md](research.md).

## Module roadmap

1. **Forecast + staffing engine** (v1, this build): load interval history, forecast via comparable methods including a custom ensemble, backtest with WAPE/bias scorecard, convert to interval staffing via Erlang A/C with shrinkage and occupancy, live what-if levers.
2. Capacity planner: weekly FTE walk (attrition, hire classes, ramp, budget vs plan).
3. Queue strategy analyzer: pooled vs split required-FTE comparison, arrival correlation, mix-factor stress.
4. Intraday reforecast simulator: morning-actuals ratio reforecast, skill-move what-ifs.

v1 ships alone and gets perfected before module 2 starts.

## Stack

- Vite + React + TypeScript, fully client-side. No backend: `npm install && npm run dev` runs it; the same build deploys as a static site (GitHub Pages/Vercel) for a live resume link.
- All math hand-implemented in `src/engine/` as pure TypeScript functions with unit tests (Vitest). No stats libraries: the implementations are the portfolio.
- Charts: Recharts (declarative, small API surface).
- No stored state beyond the browser; CSV in, everything computed on the fly. Forecasts, backtests, and staffing solves run in a shared Web Worker (`src/engine/worker.ts`), with an in-process fallback where Worker is unavailable. Scenario settings round-trip through the URL hash for shareable links.

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

## What-if levers (v1 scope)

Sliders recomputing the staffing grid live: volume +/-30%, AHT +/-20%, shrinkage 0-50%, SL target, patience, abandonment cap, occupancy cap, chat concurrency, Erlang A/C mode. Side-by-side scenario A/B with per-day deltas (scheduled FTE-hours, peak heads, SL, cost). A fixed-staff mode projects service at a given head count instead of solving for one. Optional cost-per-hour rate prices scheduled FTE-hours; forecast, scorecard, and staffing tables export as CSV.

## UI layout

Single-page, four tabs matching the pipeline: **Data** (upload/sample, cleaning report), **Forecast** (actual vs per-method overlay, horizon picker), **Accuracy** (scorecard table + bias chart), **Staffing** (interval requirement grid + what-if panel). Dark-capable, keyboard-free operation, every metric labeled with its WFM term (SL, ASA, occupancy, shrinkage) since the audience is WFM hiring managers.

## Verification bar

- Unit tests: Erlang B/C/A against published table values; Holt-Winters against a hand-computed small series; WAPE/MAPE/bias on toy vectors; profile shares sum to 1.
- Backtest smoke: on bundled sample, ensemble WAPE <= best single component at daily grain (assert in test with tolerance; if it fails the weighting is wrong).
- `npm run build` clean; README documents run steps.
