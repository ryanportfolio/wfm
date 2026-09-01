# Architecture

Client-side single-page app. No backend; the only persistence is localStorage (theme choice) and the URL hash (staffing scenario settings).

Data flow, per queue:

1. `src/engine/csv.ts` / `sampleData.ts` produce `IntervalRecord[]` (30-minute rows: ts, queue, offered, aht).
2. `series.ts` groups records into contiguous per-day buckets (calendar math lives here; `holidays.ts` builds US federal holiday sets from it); `clean.ts` flags MAD outliers and closed holidays.
3. `forecastPipeline.ts` runs the component models (`forecast/sma.ts`, `holtWinters.ts`, `dhr.ts`), fits ensemble weights (`forecast/ensemble.ts`), spreads daily totals to intervals (`profiles.ts`), and calibrates 80% bands (`intervals.ts`).
4. `staffing.ts` turns the interval forecast into a staffing grid via `erlang.ts` (Erlang B/C/A); `applyScenario` re-runs it on every slider move.
5. `backtest.ts` scores every method rolling-origin, using `metrics.ts` (WAPE, MAPE, bias).

Worker boundary: the UI calls forecast, backtest, and staffing through `src/ui/workerClient.ts`, which talks to the singleton worker `src/engine/worker.ts`; request/response framing and supersede logic live in `workerProtocol.ts`. When Worker is unavailable (vitest, old browsers) the same engine functions run in-process via dynamic import.

UI: `App.tsx` owns the dataset, queue choice, horizon, and a per-(queue, horizon) forecast cache. Four tab panels under `src/ui/` (`DataTab`, `ForecastTab`, `AccuracyTab`, `StaffingTab`); Recharts wrappers in `ui/charts/`, scenario sliders in `ui/controls/`, theme in `ui/theme.ts`, scenario link encoding in `ui/scenarioUrl.ts`.

Engine rule: everything in `src/engine/` is pure, dependency-free TypeScript with unit tests; the UI never computes forecasts or staffing itself.
