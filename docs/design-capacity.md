# Design: module 2, capacity planner

Weekly FTE capacity plan, the standing artifact of long-range WFM (research.md section 4, sources S30-S31): a demand block, a supply block (headcount walk), and the over/(under) line that drives hiring decisions. Ships as a fifth tab in the existing workbench; all math stays in `src/engine/` as pure tested TypeScript.

## Scope

In: weekly demand FTE from forecast volume and assumptions, headcount walk with hire classes, attrition, ramp, shrinkage; over/(under) per week; base/upside/downside scenarios; sensitivity table; a hiring suggestion solver.
Out (later modules): intraday reallocation (module 4), multi-queue pooling tradeoffs (module 3), budget-dollars conversion.

## Horizon and grain

Weekly columns, Monday-start weeks. Default 52 weeks, configurable 13-78. Planning starts the week after the loaded history ends.

## Demand block

Per queue (and an all-queues roll-up):

1. **Weekly volume baseline**: same-ISO-week average from cleaned history (2 years of sample data gives 2 observations per week; recency-weighted), times a compounding weekly growth rate slider seeded from the DHR trend coefficient. Every weekly value is user-overridable in the grid (marketing events, known one-offs).
2. **AHT assumption**: trailing 8-week volume-weighted AHT, user-overridable per week.
3. **Required FTE, interval-true**: distribute the week's volume to interval grain with the module 1 intraday profiles, run the module 1 staffing engine (Erlang A default, same config panel: SL target, patience, occupancy cap), sum required agent-hours, divide by productive hours per FTE per week. This reuses `buildStaffingGrid` rather than the crude `workload / occupancy` shortcut, and is the differentiator over spreadsheet capacity plans.
4. **Shrinkage gross-up** on top, as in module 1 (divide by 1 - shrinkage). Shrinkage is a weekly-editable row: planned shrinkage varies seasonally (summer vacation, December).

Config: paid hours per FTE-week (default 40), productive hours = paid x (1 - shrinkage) applied at the gross-up step only (no double count).

## Supply block: the headcount walk

Week-by-week recursion:

```
production_hc[w] = production_hc[w-1]
                 + graduates[w]              # classes finishing nesting
                 - attrition_production[w]   # rate/52, compounding
                 +/- adjustments[w]          # manual transfers
```

- **Hire classes**: list of {startWeek, size, trainingWeeks (default 6), nestingWeeks (default 4), nestingProductivity (default 0.5)}. Trainees are headcount but contribute 0 productive FTE; nesting contributes size x nestingProductivity; graduates join production at full weight. In-training attrition (default 10% per class, front-loaded) shrinks the class before graduation.
- **Attrition**: annual % (default 30%) converted to weekly, applied to production headcount; separate in-training attrition. Both user-editable.
- **Productive FTE supply**: production_hc x ramp curve. New graduates ramp 50% -> 100% linearly over rampWeeks (default 8). Track cohort ages to apply the curve per cohort, not as a blanket factor.

## Bottom line and solver

- **Over/(under)** = supply FTE - required FTE per week, with a heat-colored row and chart (supply line vs requirement line, hire classes as markers).
- **Projected weekly SL**: invert the staffing engine: given supply converted back to interval agents via the same profiles, what SL does the week deliver? Gives the "misses start in March" view that makes underlaps concrete.
- **Hiring suggestion solver**: greedy pass: walk weeks in order; when projected over/(under) goes negative and stays negative, place the smallest class (respecting min class size, max class size, training + nesting lead time, and a max-classes-per-quarter constraint) that restores non-negative coverage; repeat. Output: suggested class list the user can accept into the plan with one click. Greedy is transparent and explainable, which beats an opaque optimum for a portfolio artifact; the doc states the limitation.

## Scenarios and sensitivity

- Three named scenarios (base, upside, downside) share the structural plan but override: volume growth, AHT delta, attrition, shrinkage. Toggle between them; a comparison strip shows peak under-coverage and total hire count per scenario.
- Sensitivity table: one-lever-at-a-time deltas (volume +/-10%, AHT +/-5%, attrition +/-10pp, shrinkage +/-5pp) -> change in average required FTE, worst-week gap, and classes needed. Recomputed on demand, not per keystroke.

## Data model (new types, src/engine/capacity.ts)

```ts
interface HireClass { id: string; startWeek: string; size: number; trainingWeeks: number; nestingWeeks: number; nestingProductivity: number }
interface CapacityAssumptions {
  queue: string; weeks: number; paidHoursPerWeek: number
  growthWeeklyPct: number; ahtOverrides: Map<string, number>; volumeOverrides: Map<string, number>
  shrinkageByWeek: Map<string, number>; defaultShrinkage: number
  attritionAnnualPct: number; trainingAttritionPct: number
  startingProductionHc: number; rampWeeks: number
  hireClasses: HireClass[]
  staffing: StaffingConfig            // reuse module 1 config
}
interface CapacityWeek {
  week: string; volume: number; aht: number; requiredFte: number
  productionHc: number; inTrainingHc: number; supplyFte: number
  overUnder: number; projectedSl: number
}
```

`buildCapacityPlan(records, assumptions) -> { weeks: CapacityWeek[], seededBaseline, solverSuggestions }`, pure, memoizable.

## UI (CapacityTab)

Left rail: assumptions (growth, attrition, shrinkage default, ramp, class defaults), scenario picker, "Suggest hiring" button. Main: supply-vs-required chart with class markers, weekly grid (editable volume/AHT/shrinkage cells, over/under heat row, projected SL row), hire-class list with add/remove, sensitivity table card, scenario comparison strip. Export the plan grid as CSV (serialize helper exists).

## Verification bar

- Unit tests: headcount walk arithmetic on a hand-computed 12-week case (class graduation timing, compounding attrition, ramp weights); demand FTE against a direct erlang-sum recomputation for one week; solver restores non-negative coverage on a constructed shortfall and respects lead time; scenario overrides isolated (base unchanged when editing downside).
- Property: over/(under) responds monotonically to each lever in the expected direction.
- Integration: sample data end-to-end plan renders 52 weeks in < 1s.
- Browser-verified all interactions before the module is called done; same audit discipline as module 1.

## Build rounds (long-horizon)

1. Engine: weekly baseline seeding + demand FTE (reuses profiles/staffing) + tests.
2. Engine: headcount walk + solver + scenarios + tests.
3. UI: CapacityTab + editable grid + charts, browser-verified.
4. Audit, README/docs update, PR.
