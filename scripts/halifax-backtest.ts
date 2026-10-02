// Runs the app's own backtest on the committed Halifax 311 CSV and prints the
// scorecard and data diagnostics as markdown.
//
//   npx vite-node scripts/halifax-backtest.ts
//
// The figures come from scripts/halifaxReport.ts; docs/backtest-halifax.md
// quotes them and scripts/halifaxReport.test.ts pins them.

import csv from '../public/data/halifax-311.csv?raw'
import { buildHalifaxReport } from './halifaxReport'

const started = performance.now()
const report = buildHalifaxReport(csv)
for (const { title, body } of report.sections) console.log(`### ${title}\n\n${body}\n`)
console.log(`(computed in ${((performance.now() - started) / 1000).toFixed(1)} s)`)
