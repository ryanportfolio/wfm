import { useEffect, useMemo, useState } from 'react'
import type { BacktestReport, BacktestScore, IntervalRecord } from '../engine/types'
import type { BacktestScoreDetailed } from '../engine/backtest'
import { runBacktest } from '../engine/forecastPipeline'
import type { ChartTheme, UiMethod } from './theme'
import { METHOD_SHORT, UI_METHODS } from './theme'
import { WapeBarChart } from './charts/WapeBarChart'
import type { WapeBarRow } from './charts/WapeBarChart'
import { fmtPct, fmtSignedPct } from './format'
import { errorMessage } from './errors'

type Grain = 'interval' | 'daily' | 'weekly'
const GRAINS: Grain[] = ['interval', 'daily', 'weekly']
const GRAIN_LABELS: Record<Grain, string> = { interval: 'Interval', daily: 'Daily', weekly: 'Weekly' }

interface AccuracyTabProps {
  records: IntervalRecord[]
  queue: string
  theme: ChartTheme
}

export function AccuracyTab({ records, queue, theme }: AccuracyTabProps) {
  const [results, setResults] = useState<Record<string, BacktestReport[]>>({})
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // New dataset invalidates every cached backtest.
  useEffect(() => {
    setResults({})
    setRunError(null)
  }, [records])

  const reports = results[queue]

  const run = () => {
    setRunning(true)
    setRunError(null)
    // Yield a frame so the spinner paints before the backtest blocks the thread.
    setTimeout(() => {
      try {
        const out = runBacktest(records, queue, { folds: 8, horizonDays: 28 })
        setResults((prev) => ({ ...prev, [queue]: out }))
      } catch (err) {
        setRunError(errorMessage(err))
      } finally {
        setRunning(false)
      }
    }, 30)
  }

  const scoreOf = useMemo(() => {
    if (!reports) return null
    const map = new Map<string, BacktestScoreDetailed>()
    for (const report of reports) {
      for (const s of report.scores) {
        map.set(`${s.method}|${s.grain}`, s as BacktestScoreDetailed)
      }
    }
    return (method: UiMethod, grain: Grain) => map.get(`${method}|${grain}`)
  }, [reports])

  // Best value per column: lowest WAPE, lowest MAPE, bias closest to zero.
  const best = useMemo(() => {
    if (!scoreOf) return null
    const out = new Map<string, UiMethod>()
    for (const grain of GRAINS) {
      let bWape: UiMethod = 'sma'
      let bMape: UiMethod = 'sma'
      let bBias: UiMethod = 'sma'
      for (const m of UI_METHODS) {
        const s = scoreOf(m, grain)
        const cur = { wape: scoreOf(bWape, grain), mape: scoreOf(bMape, grain), bias: scoreOf(bBias, grain) }
        if (!s) continue
        if (cur.wape && s.wape < cur.wape.wape) bWape = m
        if (cur.mape && s.mape < cur.mape.mape) bMape = m
        if (cur.bias && Math.abs(s.bias) < Math.abs(cur.bias.bias)) bBias = m
      }
      out.set(`wape|${grain}`, bWape)
      out.set(`mape|${grain}`, bMape)
      out.set(`bias|${grain}`, bBias)
    }
    return out
  }, [scoreOf])

  const wapeRows = useMemo<WapeBarRow[]>(() => {
    if (!scoreOf) return []
    return UI_METHODS.map((m) => ({
      method: m,
      label: METHOD_SHORT[m],
      wape: scoreOf(m, 'daily')?.wape ?? 0,
    }))
  }, [scoreOf])

  const coverage = (grain: Grain): number | null => {
    const s = scoreOf?.('ensemble', grain)
    return s ? s.mapeCoverage : null
  }

  const folds = reports?.[0]?.folds ?? 0

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">
          <h2>Backtest scorecard: {queue}</h2>
          <span className="card-subtitle">
            Rolling-origin backtest, 8 folds, 28-day horizon, scored against raw actuals
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" disabled={running} onClick={run}>
            {running ? (
              <>
                <span className="spinner" /> Running backtest...
              </>
            ) : reports ? (
              'Rerun backtest'
            ) : (
              'Run backtest'
            )}
          </button>
        </div>

        {runError && (
          <div className="note error-text">
            Backtest failed: {runError}. Use the button above to try again.
          </div>
        )}

        {!reports && !running && !runError && (
          <div className="note">
            Run the backtest to score every method out of sample. Each fold trains on history up
            to its origin and forecasts the next 28 days; errors are pooled across folds.
          </div>
        )}

        {reports && folds === 0 && (
          <div className="note">
            Not enough history to backtest: this queue needs at least 168 days (140 training days
            plus the 28-day horizon) before one fold can run. Load a longer history to score the
            methods out of sample.
          </div>
        )}

        {reports && folds > 0 && scoreOf && best && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Method</th>
                    {GRAINS.map((g) => (
                      <th key={`w-${g}`} className="num">
                        WAPE {GRAIN_LABELS[g].toLowerCase()}
                      </th>
                    ))}
                    {GRAINS.map((g) => (
                      <th key={`m-${g}`} className="num">
                        MAPE {GRAIN_LABELS[g].toLowerCase()}
                      </th>
                    ))}
                    {GRAINS.map((g) => (
                      <th key={`b-${g}`} className="num">
                        Bias {GRAIN_LABELS[g].toLowerCase()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {UI_METHODS.map((m) => (
                    <tr key={m}>
                      <td>{METHOD_SHORT[m]}</td>
                      {GRAINS.map((g) => {
                        const s = scoreOf(m, g) as BacktestScore
                        return (
                          <td key={`w-${g}`} className={`num${best.get(`wape|${g}`) === m ? ' best' : ''}`}>
                            {fmtPct(s.wape)}
                          </td>
                        )
                      })}
                      {GRAINS.map((g) => {
                        const s = scoreOf(m, g) as BacktestScore
                        return (
                          <td key={`m-${g}`} className={`num${best.get(`mape|${g}`) === m ? ' best' : ''}`}>
                            {fmtPct(s.mape)}
                          </td>
                        )
                      })}
                      {GRAINS.map((g) => {
                        const s = scoreOf(m, g) as BacktestScore
                        return (
                          <td key={`b-${g}`} className={`num${best.get(`bias|${g}`) === m ? ' best' : ''}`}>
                            {fmtSignedPct(s.bias)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginBottom: 0 }}>
              {folds} folds ran. Best value per column is highlighted. MAPE skips zero-actual
              points, so it scored {coverage('interval') !== null ? fmtPct(coverage('interval')!) : 'n/a'} of
              interval points, {coverage('daily') !== null ? fmtPct(coverage('daily')!) : 'n/a'} of days, and{' '}
              {coverage('weekly') !== null ? fmtPct(coverage('weekly')!) : 'n/a'} of weeks; WAPE and bias score
              every point.
            </p>
          </>
        )}
      </div>

      {reports && folds > 0 && (
        <div className="two-col">
          <div className="card">
            <div className="card-title">
              <h2>Daily WAPE by method</h2>
              <span className="card-subtitle">Lower is better</span>
            </div>
            <WapeBarChart rows={wapeRows} theme={theme} />
          </div>
          <div className="card">
            <div className="card-title">
              <h2>Reading the scorecard</h2>
            </div>
            <p className="prose" style={{ marginTop: 0, marginBottom: 0 }}>
              WAPE weights every error by volume: it divides the sum of absolute errors by total
              actual contacts, so a miss on a 3,000-contact Monday counts far more than the same
              percentage miss on a quiet Saturday. MAPE instead averages each point&apos;s
              percentage error equally, which lets small denominators dominate: an interval
              expecting 4 contacts that gets 8 scores as a 100% miss even though it is off by only
              4 contacts, and zero-volume intervals cannot be scored at all (see the coverage note
              above). That small-denominator effect is also why interval-grain numbers read worse
              than daily or weekly ones: the same forecast sliced into 48 intervals inherits pure
              arrival noise that daily totals average away. For staffing decisions, daily WAPE is
              the primary planning number, and interval WAPE mostly reflects how well the intraday
              profile fits. Bias shows direction: positive means the method over-forecasts on
              balance, negative means it under-forecasts.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
