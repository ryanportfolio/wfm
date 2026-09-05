import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { IntradayResult } from '../../engine/intraday'
import type { ChartTheme } from '../theme'
import { tooltipStyle } from '../theme'

export function IntradayChart({ result, theme }: { result: IntradayResult; theme: ChartTheme }) {
  return <div role="figure" aria-label="Baseline and revised contacts by half hour. Exact values and observed status are in the interval table.">
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={result.rows} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis dataKey="ts" tickFormatter={v => String(v).slice(11, 16)} stroke={theme.axis} /><YAxis stroke={theme.axis} />
        <Tooltip contentStyle={tooltipStyle(theme)} labelFormatter={v => String(v).slice(11, 16)} /><Legend />
        <Line dataKey="baseline" name="Baseline contacts" stroke={theme.actual} strokeDasharray="5 4" isAnimationActive={false} dot={false} />
        <Line dataKey="revised" name="Observed / revised contacts" stroke="#009E73" strokeWidth={3} isAnimationActive={false} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>
}
