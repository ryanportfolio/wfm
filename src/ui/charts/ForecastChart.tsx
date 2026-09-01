import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartTheme, UiMethod } from '../theme'
import { METHOD_COLORS, METHOD_SHORT, tooltipStyle } from '../theme'
import { fmtCompact, fmtDateLong, fmtDateShort, fmtInt } from '../format'

export interface ForecastChartRow {
  date: string
  actual?: number
  sma?: number
  hw?: number
  dhr?: number
  ensemble?: number
  /** [lo, hi] edges of the ensemble 80% band; only on forecast rows */
  band?: [number, number]
}

interface ForecastChartProps {
  rows: ForecastChartRow[]
  lastActualDate: string
  visible: Record<UiMethod, boolean>
  theme: ChartTheme
}

export function ForecastChart({ rows, lastActualDate, visible, theme }: ForecastChartProps) {
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={fmtDateShort}
          tick={{ fill: theme.axis, fontSize: 11 }}
          stroke={theme.grid}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={fmtCompact}
          tick={{ fill: theme.axis, fontSize: 11 }}
          stroke={theme.grid}
          width={48}
        />
        <Tooltip
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          labelFormatter={(v) => fmtDateLong(String(v))}
          formatter={(value, name) =>
            Array.isArray(value)
              ? [`${fmtInt(Number(value[0]))} to ${fmtInt(Number(value[1]))}`, String(name)]
              : [fmtInt(Number(value)), String(name)]
          }
        />
        <ReferenceLine
          x={lastActualDate}
          stroke={theme.axis}
          strokeDasharray="4 4"
          label={{ value: 'Forecast start', fill: theme.axis, fontSize: 11, position: 'insideTopRight' }}
        />
        {visible.ensemble && (
          <Area
            dataKey="band"
            name="80% range"
            stroke="none"
            fill={METHOD_COLORS.ensemble}
            fillOpacity={0.16}
            activeDot={false}
            isAnimationActive={false}
          />
        )}
        <Line
          type="monotone"
          dataKey="actual"
          name="Actual"
          stroke={theme.actual}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        {visible.sma && (
          <Line
            type="monotone"
            dataKey="sma"
            name={METHOD_SHORT.sma}
            stroke={METHOD_COLORS.sma}
            strokeWidth={1.6}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
          />
        )}
        {visible.hw && (
          <Line
            type="monotone"
            dataKey="hw"
            name={METHOD_SHORT.hw}
            stroke={METHOD_COLORS.hw}
            strokeWidth={1.6}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
          />
        )}
        {visible.dhr && (
          <Line
            type="monotone"
            dataKey="dhr"
            name={METHOD_SHORT.dhr}
            stroke={METHOD_COLORS.dhr}
            strokeWidth={1.6}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
          />
        )}
        {visible.ensemble && (
          <Line
            type="monotone"
            dataKey="ensemble"
            name={METHOD_SHORT.ensemble}
            stroke={METHOD_COLORS.ensemble}
            strokeWidth={2.8}
            dot={false}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
