import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DailyPoint } from '../../engine/types'
import type { ChartTheme } from '../theme'
import { EXTRA_COLORS, tooltipStyle } from '../theme'
import { fmtCompact, fmtDateLong, fmtDateShort, fmtInt } from '../format'

interface DailyHistoryChartProps {
  points: DailyPoint[]
  theme: ChartTheme
}

export function DailyHistoryChart({ points, theme }: DailyHistoryChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={fmtDateShort}
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          minTickGap={60}
        />
        <YAxis
          tickFormatter={fmtCompact}
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          width={48}
        />
        <Tooltip
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          labelFormatter={(v) => fmtDateLong(String(v))}
          formatter={(value) => [fmtInt(Number(value)), 'Contacts offered']}
        />
        <Line
          type="monotone"
          dataKey="total"
          stroke={EXTRA_COLORS.staffing}
          strokeWidth={1.4}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
