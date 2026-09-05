# WFM planning workflows Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extend the workbench from forecast and interval staffing into trustworthy imports, capacity decisions, portable projects, and intraday adjustments.

**Architecture:** Keep math in dependency-free TypeScript functions and React state above the tab boundaries. New views use the existing design tokens and Recharts. Project JSON is a versioned local file, validated completely before replacing live state.

**Tech Stack:** Existing React 19, TypeScript, Vite, Recharts, Vitest and Testing Library. No new runtime packages.

---

## Approved design and execution

The user approved the preceding recommendation and requested Long-horizon execution. The coordinator keeps the frozen acceptance contract and audit ledger in `.tmp/long-horizon/development/state.md`. Each slice gets a fresh executor and then a separate fresh auditor. Only auditor-confirmed results count as complete. Seven slices, at most fourteen execution/audit rounds. No commits, pushes, or deployments are part of this request.

Workflow steps, preserved from Long-horizon: **Plan**, **Execute**, **Audit**, **Integrate**. Each executor follows Fable's **Scope before work**, **Evidence before reasoning**, **Reason adversarially**, **Verify before declaring done**, and **Report calibrated**. Skip the writing-plans execution-choice question because the user already selected Long-horizon. Skip automatic commits because repository authorization excludes them.

## Shared decisions

- Existing forecast UI supports 7, 14 and 28 days. Capacity uses 13 editable weekly demand assumptions. Seed from available staffing requirements only when explicitly requested; label extrapolated weeks as assumptions.
- Capacity demand and supply use productive FTE. Convert required on-contact hours to FTE using weekly paid hours; apply shrinkage once to supply. A trainee is paid during training but contributes no productive capacity until training finishes. Attrition applies consistently at weekly boundaries; label timing.
- Hiring v1 compares no-hire baseline with one proposed class. Inputs include headcount, weekly attrition, paid hours, shrinkage, hourly cost, class start, training weeks and ramp weeks. No scheduling optimizer or hiring recommendation algorithm.
- Project files store all queues' interval rows and user settings. Import is atomic; bad files retain the existing project. Browser theme is a preference, not project data. Files include a name and schema version.
- Intraday observes intervals through a chosen cutoff. Observed zero is a real value; blank is missing. Remaining intervals use actual-to-baseline ratio from observed intervals only. Zero observed baseline requires an explicit safe fallback explanation. Staffing can vary per interval. Show baseline and revised demand/requirements, plus projected service under entered staffing.
- Stay consistent with warm cream/indigo design, dark mode, keyboard tab navigation and narrow layouts. Add tables so charts are not the only source of numeric results.

## Task 1: data integrity

Files: `src/engine/dataQuality.ts`, `src/engine/dataQuality.test.ts`, `src/engine/csv.ts`, `src/engine/csv.test.ts`, `src/ui/DataTab.tsx`, `src/App.tsx`, and focused UI tests.

- [x] Before edits, write a slice brief with final interfaces and concrete fixture arithmetic to scratch.
- [x] Detect duplicate normalized queue/timestamp keys. Reject ambiguous duplicate imports or present an explicit resolution; never silently sum them.
- [x] Report missing calendar dates and missing expected interval slots separately from explicit zero rows. Infer operating slots conservatively from queue weekday history and disclose that inferred gaps can be closures.
- [x] Add compact Data-tab diagnostics with counts and bounded examples. Avoid materializing huge gap lists.
- [x] Run `npm test -- src/engine/csv.test.ts src/engine/dataQuality.test.ts` plus affected UI tests. Auditor tests zero rows, duplicate seconds normalization, unsorted input, and closure ambiguity.

## Task 2: capacity arithmetic

Files: `src/engine/capacity.ts`, `src/engine/capacity.test.ts`.

- [x] Define serializable inputs and weekly outputs before implementation.
- [x] Implement 13-week no-hire and proposed-class walks, productive capacity, shortages, paid cost and CSV-friendly outputs.
- [x] Verify hand-computable cases: 100 heads with 20% shrinkage yields 80 productive FTE; 10% weekly attrition produces 90 then 81 survivors according to documented timing; trainees add cost immediately and capacity only after training; zero demand/headcount remains finite.
- [x] Reject nonfinite, negative and out-of-domain inputs. Never apply shrinkage to both demand and supply.
- [x] Run `npm test -- src/engine/capacity.test.ts` and inspect actual numeric outputs.

## Task 3: capacity workflow

Files: `src/ui/CapacityTab.tsx`, `src/ui/capacityState.ts`, `src/ui/charts/CapacityChart.tsx`, `src/ui/CapacityTab.test.tsx`, `src/ui/Tabs.tsx`, `src/App.tsx`, `src/App.test.tsx`, `src/index.css`.

- [x] Implement one queue's 13 editable demand rows, class controls and productive-FTE explanations.
- [x] Show first shortage, baseline/proposal gap, cost delta, chart and weekly comparison table; export matching CSV.
- [x] Integrate accessible tab/empty state and stable parent-owned settings. Changing queues must not silently reuse another queue's plan.
- [x] Explicitly label demand seeds and any extrapolation. Provide a reproducible illustrative hiring scenario.
- [x] Run `npm test -- src/ui/CapacityTab.test.tsx src/App.test.tsx` and `npm run build`.

## Task 4: portable projects

Files: `src/ui/project.ts`, `src/ui/project.test.ts`, `src/ui/ProjectControls.tsx`, `src/ui/ProjectControls.test.tsx`, `src/ui/StaffingTab.tsx`, `src/App.tsx`, and necessary state adapters.

- [x] Add project name, save JSON and open JSON actions. Persist history, queue, horizon, staffing A/B/cost, capacity state and reserved explicit intraday state contract.
- [x] Lift state needed for a complete round-trip; retain scenario URL compatibility and precedence rules.
- [x] Validate version, structure, numbers and queue references; reject malformed imports atomically with readable errors.
- [x] Test complete round-trip and failed imports preserving the current workspace.
- [x] Run focused project/UI tests, `npm run lint`, and `npm run build`.

## Task 5: intraday workflow

Files: `src/engine/intraday.ts`, `src/engine/intraday.test.ts`, `src/ui/IntradayTab.tsx`, `src/ui/IntradayTab.test.tsx`, `src/ui/charts/IntradayChart.tsx`, and App/Tabs/project-file integration.

- [x] Implement the observed/remaining boundary and ratio reforecast with missing/zero-baseline handling.
- [x] Use existing staffing functions for baseline/revised interval requirements and projected service at editable interval heads.
- [x] Show observed values, baseline/revised remainder, staffing gaps and assumptions; export rows as CSV.
- [x] Persist inputs by queue/day without applying stale observations to a new dataset.
- [x] Verify observed-interval invariance, future-actual exclusion, zero demand, zero baseline and queue/day switching; run focused tests and build.

## Task 6: integration and documentation

Files: README, `docs/design.md`, `.claude/reference/architecture.md`, relevant source/tests only for demonstrated integration defects.

- [x] Run `npm test`, `npm run lint`, `npm run build`; record exact output under scratch evidence.
- [x] Exercise all new workflows together, including project import/export and legacy scenario links.
- [x] Update usage, implemented roadmap entries, timing assumptions, limitations and next work accurately.
- [x] Auditor independently checks full-suite evidence and final diff boundaries.

## Task 7: rendered verification

Files: scratch screenshots/evidence and narrow fixes justified by rendered results.

- [x] Serve this worktree on a verified unused fixed localhost port.
- [x] Inspect actual desktop and narrow rendered Data, Capacity, Project and Intraday flows, dark mode, tables and keyboard controls. Capture screenshots.
- [x] Correct observed defects, rerun affected checks, and leave preview available for user inspection.
- [x] Independent auditor reproduces key interactions and verifies the final build/test results. Mark only independently passed steps complete.

## Integration evidence status (2026-09-04)

Independent audit accepted data integrity, capacity arithmetic/workflow and portable projects in rounds 2–5. The round 6 intraday audit found scheduled-head CSV rounding could change implied whole on-contact bodies; the integration round preserves exact scheduled-head numbers and adds a regression. Shared staffing workload limits follow bounded reproductions of oversized required-agent and fixed-staff loops. Decimal overflow rejection and first-upload error copy are also covered by regressions.

The coordinator accepted tasks 1–6 after independent round 8 audit: 372 tests in 36 files, lint, TypeScript, production build, bounded computational probes and fresh integration checks passed. Erlang A now limits waiting-phase work and only uses its long-window shortcut within a proved 1e-12 late-service error bound. Audit evidence is recorded under `.tmp/long-horizon/development/r8-audit-evidence.md`. Task 7 passed the fresh independent round 9 audit: real project save/reopen, invalid-file preservation, capacity and intraday interactions, desktop/narrow dark screenshots, keyboard scrolling, no page overflow and clean console. The final 372-test suite, lint, TypeScript and production build also passed. Evidence: `.tmp/long-horizon/development/r9-audit-evidence.md`. Tests used direct Node CLIs equivalent to the package scripts because the local npm PowerShell wrapper strips flags. No deployment is part of this work.

## Claude review closure

The user subsequently requested Claude review and merge if clear. One Claude Fable 5.1 high-effort review produced five actionable findings, verified and fixed locally: quarter-hour capacity seeding, inactive intraday draft saves, hidden-panel worker startup, a throughput lower bound for Erlang search, and chart accessibility semantics. A bulk-zero-entry helper remains an optional UX suggestion. Five new regressions bring the full suite to 377 tests; lint, TypeScript and build pass. Real-browser save/reactivation and chart-semantic checks also pass. Merge remains gated on GitHub CI for the final commit.
