import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartTheme } from '../theme'
import { EXTRA_COLORS, METHOD_COLORS, METHOD_SHORT, tooltipStyle } from '../theme'
import { fmtPct } from '../format'

/** Daily WAPE per method at one lead day; missing = no pooled volume that day. */
export interface LeadTimeRow {
  lead: number
  sma?: number
  hw?: number
  dhr?: number
  equal?: number
  ensemble?: number
}

interface LeadTimeChartProps {
  rows: LeadTimeRow[]
  theme: ChartTheme
}

export function LeadTimeChart({ rows, theme }: LeadTimeChartProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="lead"
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          minTickGap={16}
          label={{ value: 'Lead day', fill: theme.axis, fontSize: 12, position: 'insideBottom', dy: 14 }}
        />
        <YAxis
          tickFormatter={(v) => fmtPct(Number(v), 0)}
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          width={48}
        />
        <Tooltip
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          labelFormatter={(v) => `Lead day ${v}`}
          formatter={(value, name) => [fmtPct(Number(value)), String(name)]}
        />
        <Line
          type="monotone"
          dataKey="sma"
          name={METHOD_SHORT.sma}
          stroke={METHOD_COLORS.sma}
          strokeWidth={1.4}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="hw"
          name={METHOD_SHORT.hw}
          stroke={METHOD_COLORS.hw}
          strokeWidth={1.4}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="dhr"
          name={METHOD_SHORT.dhr}
          stroke={METHOD_COLORS.dhr}
          strokeWidth={1.4}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="equal"
          name="Equal-weight blend"
          stroke={EXTRA_COLORS.equal}
          strokeWidth={1.4}
          strokeDasharray="5 3"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="ensemble"
          name={METHOD_SHORT.ensemble}
          stroke={METHOD_COLORS.ensemble}
          strokeWidth={2.6}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
