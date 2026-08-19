import { fmtNum, fmtSigned } from '../format'

export interface SensitivityRow {
  lever: string
  /** Change in average weekly required FTE vs the current plan */
  deltaAvgRequired: number
  /** Worst-week over/(under) in the modified run */
  worstOverUnder: number
}

interface SensitivityCardProps {
  rows: SensitivityRow[] | null
  running: boolean
  progress: string
  currentWorst: number | null
  onCompute: () => void
}

export function SensitivityCard({ rows, running, progress, currentWorst, onCompute }: SensitivityCardProps) {
  return (
    <div className="card">
      <div className="card-title">
        <h2>Sensitivity</h2>
        <span className="card-subtitle">One lever at a time against the current plan</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" disabled={running} onClick={onCompute}>
          {running ? (
            <>
              <span className="spinner" /> Computing {progress}...
            </>
          ) : rows ? (
            'Recompute'
          ) : (
            'Compute'
          )}
        </button>
      </div>

      {!rows && !running && (
        <div className="note">
          Eight plan reruns: volume +/-10%, AHT +/-5%, attrition +/-10 pts, shrinkage +/-5 pts.
          Computed on demand, not per keystroke.
        </div>
      )}

      {rows && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Lever</th>
                  <th className="num">Delta avg required FTE</th>
                  <th className="num">Worst-week over/(under)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lever}>
                    <td>{r.lever}</td>
                    <td className="num">{fmtSigned(r.deltaAvgRequired, 1)}</td>
                    <td className={`num ${r.worstOverUnder < 0 ? 'heat-neg' : 'heat-pos'}`}>
                      {fmtSigned(r.worstOverUnder, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {currentWorst !== null && (
            <p className="note" style={{ marginBottom: 0 }}>
              Current plan worst-week over/(under): {fmtNum(currentWorst, 1)} FTE. Rows rerun the
              full plan with one assumption changed; results clear when the plan changes.
            </p>
          )}
        </>
      )}
    </div>
  )
}
