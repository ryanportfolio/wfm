# Architecture

Client-side React single-page app with no backend. Data and working plans live in memory. Users explicitly save/open local JSON project files; there is no automatic project persistence or upload. Theme uses localStorage, and staffing scenarios can also use the URL hash.

Data flow, per queue:

1. `src/engine/csv.ts` / `sampleData.ts` produce `IntervalRecord[]`. CSV rejects normalized duplicates atomically and reports other invalid rows. `dataQuality.ts` reports missing dates, inferred missing slots and explicit zero rows.
2. `series.ts` groups records into contiguous daily buckets; `holidays.ts` uses its calendar math. `clean.ts` flags MAD outliers and closed holidays. Diagnostics leave the existing zero-fill and cleaning assumptions visible.
3. `forecastPipeline.ts` runs the component models (`forecast/sma.ts`, `holtWinters.ts`, `dhr.ts`), fits ensemble weights (`forecast/ensemble.ts`), spreads daily totals to intervals (`profiles.ts`), and calibrates 80% bands (`intervals.ts`).
4. `staffing.ts` turns interval forecasts into grids through `erlang.ts`; `applyScenario` applies staffing levers. Required/fixed-staff paths reject load above 1,000 Erlangs and on-contact staffing above 2,000 before expensive recursion; unmet targets at the search ceiling fail explicitly.
5. `backtest.ts` scores methods rolling-origin with `metrics.ts` (WAPE, MAPE, bias).
6. `capacity.ts` computes a pure 13-week baseline and one-class proposal. `ui/capacityState.ts` adapts string drafts, explicit default-target forecast seeds, illustrative values and CSV. Productive demand uses on-contact hours; supply applies shrinkage once.
7. `intraday.ts` revises one forecast day using only elapsed observations, then compares original/revised staffing need and fixed-head service. It supports half-hour starts only and tighter 100-Erlang/500-scheduled-head/48-interval limits. `ui/intradayState.ts` owns the queue/day draft shape.

Worker boundary: `src/ui/workerClient.ts` sends forecast, backtest and staffing requests to a lazy shared `src/engine/worker.ts`; protocol framing and supersede logic live in `workerProtocol.ts`. Staffing supersedes stale responses without terminating unrelated jobs. Intraday starts a separate worker per job, terminated on edit, unmount, result, error or ten-second timeout. Without Worker support, dynamic imports run the same math on the calling thread without an interruptible timeout.

UI: `App.tsx` owns history, queue, horizon, project name, staffing A/B/cost, capacity-by-queue and intraday-by-queue/day state, plus a per-queue/horizon forecast cache. Six panels under `src/ui/` are `DataTab`, `ForecastTab`, `AccuracyTab`, `StaffingTab`, `CapacityTab` and `IntradayTab`. Parent-owned settings survive tab switches. CSV/sample replacement resets capacity/intraday drafts. `ProjectControls.tsx` provides local save/open controls, and `project.ts` strictly validates the entire v2 project before replacement; exact v1 files gain an empty intraday map. The latest import request wins. Imported settings take precedence over initial URL settings.

Recharts wrappers live in `ui/charts/`, scenario controls in `ui/controls/`, theme in `ui/theme.ts`, and legacy scenario encoding in `ui/scenarioUrl.ts`. Chart values also appear in numeric tables. Intraday UI discards stale results on input changes and retains exact entered scheduled-head precision in CSV.

Engine rule: everything in `src/engine/` is pure, dependency-free TypeScript with unit tests; UI code adapts inputs and presents outputs. Full verification uses Vitest, ESLint, TypeScript and Vite (`npm test`, `npm run lint`, `npm run build`). See `docs/design.md` for model and persistence assumptions.
