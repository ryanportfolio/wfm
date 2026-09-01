import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartTheme } from '../theme'
import { EXTRA_COLORS, METHOD_COLORS, tooltipStyle } from '../theme'
import { fmtNum } from '../format'

export interface StaffingRow {
  time: string
  scheduled: number
  required: number
  /** Fixed-staff mode: projected SL misses the target here; bar turns red. */
  understaffed?: boolean
  /** Fixed-staff Erlang C: queue grows without bound at this volume. */
  unstable?: boolean
}

interface StaffingIntervalChartProps {
  rows: StaffingRow[]
  theme: ChartTheme
}

export function StaffingIntervalChart({ rows, theme }: StaffingIntervalChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          minTickGap={30}
        />
        <YAxis
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          width={44}
          label={{
            value: 'Agents',
            angle: -90,
            position: 'insideLeft',
            fill: theme.axis,
            fontSize: 12,
          }}
        />
        <Tooltip
          cursor={{ fill: theme.grid, fillOpacity: 0.35 }}
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          formatter={(value, name) => [fmtNum(Number(value), 1), String(name)]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: theme.text }} />
        <Bar
          dataKey="scheduled"
          name="Scheduled agents (after shrinkage)"
          fill={EXTRA_COLORS.staffing}
          fillOpacity={0.75}
          isAnimationActive={false}
        >
          {rows.map((row) => (
            <Cell key={row.time} fill={row.understaffed ? theme.bad : EXTRA_COLORS.staffing} />
          ))}
        </Bar>
        <Line
          type="stepAfter"
          dataKey="required"
          name="Bodies on phones (before shrinkage)"
          stroke={METHOD_COLORS.ensemble}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
