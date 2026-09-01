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
  /** Fixed-staff ("what I have") mode: bars are the user's heads, red = target missed. */
  fixedMode?: boolean
}

export function StaffingIntervalChart({ rows, theme, fixedMode = false }: StaffingIntervalChartProps) {
  const barName = fixedMode ? 'Your scheduled heads' : 'Scheduled agents (after shrinkage)'
  const lineName = fixedMode
    ? 'Bodies needed on phones for the target'
    : 'Bodies on phones (before shrinkage)'
  // Legend is built by hand so fixed mode can carry the red missed-target
  // swatch, which is a per-cell color rather than a series of its own.
  const legendEntries = [
    { value: barName, type: 'square' as const, color: EXTRA_COLORS.staffing },
    ...(fixedMode
      ? [{ value: 'SL target missed', type: 'square' as const, color: theme.bad }]
      : []),
    { value: lineName, type: 'line' as const, color: METHOD_COLORS.ensemble },
  ]
  const legendContent = () => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '4px 16px',
        paddingTop: 4,
      }}
    >
      {legendEntries.map((e) => (
        <span key={e.value} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {e.type === 'line' ? (
            <span style={{ width: 14, height: 0, borderTop: `2px solid ${e.color}` }} />
          ) : (
            <span style={{ width: 10, height: 10, background: e.color, borderRadius: 2 }} />
          )}
          {e.value}
        </span>
      ))}
    </div>
  )
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
        <Legend wrapperStyle={{ fontSize: 12, color: theme.text }} content={legendContent} />
        <Bar
          dataKey="scheduled"
          name={barName}
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
          name={lineName}
          stroke={METHOD_COLORS.ensemble}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
