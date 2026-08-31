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
import type { CapacityWeek, HireClass } from '../../engine/capacityTypes'
import { addDays } from '../../engine/series'
import type { ChartTheme } from '../theme'
import { EXTRA_COLORS, tooltipStyle } from '../theme'
import { fmtDateShort, fmtNum } from '../format'

const REQUIRED_COLOR = '#D55E00' // Okabe-Ito vermillion
const SUPPLY_COLOR = EXTRA_COLORS.staffing // Okabe-Ito blue
const SURPLUS_FILL = '#009E73' // Okabe-Ito green
const GRAD_COLOR = '#009E73'

interface ChartRow {
  week: string
  required: number
  supply: number
  surplus?: [number, number]
  deficit?: [number, number]
}

interface CapacityChartProps {
  weeks: CapacityWeek[]
  hireClasses: HireClass[]
  theme: ChartTheme
}

/**
 * Supply vs required FTE across the plan horizon. The band between the lines
 * is shaded green where supply covers demand and red where it falls short;
 * dashed markers show each hire class start and its graduation week.
 */
export function CapacityChart({ weeks, hireClasses, theme }: CapacityChartProps) {
  const weekSet = new Set(weeks.map((w) => w.week))
  const rows: ChartRow[] = weeks.map((w) => ({
    week: w.week,
    required: w.requiredFte,
    supply: w.supplyFte,
    surplus: w.overUnder >= 0 ? [w.requiredFte, w.supplyFte] : undefined,
    deficit: w.overUnder < 0 ? [w.supplyFte, w.requiredFte] : undefined,
  }))

  const markers: { week: string; kind: 'start' | 'grad' }[] = []
  for (const hc of hireClasses) {
    if (weekSet.has(hc.startWeek)) markers.push({ week: hc.startWeek, kind: 'start' })
    const grad = addDays(hc.startWeek, 7 * (hc.trainingWeeks + hc.nestingWeeks))
    if (weekSet.has(grad)) markers.push({ week: grad, kind: 'grad' })
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis
          dataKey="week"
          tickFormatter={fmtDateShort}
          tick={{ fill: theme.axis, fontSize: 11 }}
          stroke={theme.grid}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v) => fmtNum(Number(v), 0)}
          tick={{ fill: theme.axis, fontSize: 11 }}
          stroke={theme.grid}
          width={48}
          domain={['auto', 'auto']}
        />
        <Tooltip
          contentStyle={tooltipStyle(theme)}
          labelStyle={{ color: theme.text }}
          labelFormatter={(v) => `Week of ${fmtDateShort(String(v))}`}
          formatter={(value, name) => {
            if (Array.isArray(value)) {
              const [lo, hi] = value as [number, number]
              return [fmtNum(hi - lo, 1), String(name)]
            }
            return [fmtNum(Number(value), 1), String(name)]
          }}
        />
        {markers.map((m, i) => (
          <ReferenceLine
            key={`${m.kind}-${m.week}-${i}`}
            x={m.week}
            stroke={m.kind === 'start' ? theme.axis : GRAD_COLOR}
            strokeDasharray={m.kind === 'start' ? '4 4' : '2 3'}
            label={{
              value: m.kind === 'start' ? 'Class start' : 'Graduates',
              fill: m.kind === 'start' ? theme.axis : GRAD_COLOR,
              fontSize: 10,
              position: m.kind === 'start' ? 'insideTopLeft' : 'insideBottomLeft',
            }}
          />
        ))}
        <Area
          dataKey="surplus"
          name="Surplus"
          stroke="none"
          fill={SURPLUS_FILL}
          fillOpacity={0.16}
          isAnimationActive={false}
          legendType="none"
        />
        <Area
          dataKey="deficit"
          name="Shortfall"
          stroke="none"
          fill={REQUIRED_COLOR}
          fillOpacity={0.2}
          isAnimationActive={false}
          legendType="none"
        />
        <Line
          type="monotone"
          dataKey="required"
          name="Required FTE"
          stroke={REQUIRED_COLOR}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="supply"
          name="Supply FTE"
          stroke={SUPPLY_COLOR}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
