import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ChartTheme } from '../theme'
import { EXTRA_COLORS, METHOD_COLORS, tooltipStyle } from '../theme'
import { fmtNum } from '../format'

export interface IntradayRow {
  time: string
  offered: number
  aht: number
}

interface IntradayForecastChartProps {
  rows: IntradayRow[]
  theme: ChartTheme
}

export function IntradayForecastChart({ rows, theme }: IntradayForecastChartProps) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="time"
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          minTickGap={30}
        />
        <YAxis
          yAxisId="offered"
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          width={44}
          label={{
            value: 'Offered',
            angle: -90,
            position: 'insideLeft',
            fill: theme.axis,
            fontSize: 12,
          }}
        />
        <YAxis
          yAxisId="aht"
          orientation="right"
          tick={{ fill: theme.axis, fontSize: 12 }}
          stroke={theme.grid}
          width={44}
          label={{
            value: 'AHT (s)',
            angle: 90,
            position: 'insideRight',
            fill: theme.axis,
            fontSize: 12,
          }}
        />
        <Tooltip
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          formatter={(value, name) => [
            name === 'AHT' ? `${fmtNum(Number(value), 0)} s` : fmtNum(Number(value), 1),
            String(name),
          ]}
        />
        <Bar
          yAxisId="offered"
          dataKey="offered"
          name="Forecast offered"
          fill={METHOD_COLORS.ensemble}
          fillOpacity={0.75}
          isAnimationActive={false}
        />
        <Line
          yAxisId="aht"
          type="monotone"
          dataKey="aht"
          name="AHT"
          stroke={EXTRA_COLORS.aht}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
