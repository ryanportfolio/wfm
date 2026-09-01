import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartTheme, UiMethod } from '../theme'
import { CHART_FONT_SIZE, METHOD_COLORS, tooltipStyle } from '../theme'
import { fmtPct } from '../format'

export interface WapeBarRow {
  method: UiMethod
  label: string
  wape: number
}

interface WapeBarChartProps {
  rows: WapeBarRow[]
  theme: ChartTheme
}

export function WapeBarChart({ rows, theme }: WapeBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: theme.axis, fontSize: CHART_FONT_SIZE }} stroke={theme.grid} />
        <YAxis
          tickFormatter={(v) => fmtPct(Number(v), 0)}
          tick={{ fill: theme.axis, fontSize: CHART_FONT_SIZE }}
          stroke={theme.grid}
          width={48}
        />
        <Tooltip
          cursor={{ fill: theme.grid, fillOpacity: 0.35 }}
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          formatter={(value) => [fmtPct(Number(value)), 'Daily WAPE']}
        />
        <Bar dataKey="wape" isAnimationActive={false} maxBarSize={64}>
          {rows.map((row) => (
            <Cell key={row.method} fill={METHOD_COLORS[row.method]} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
