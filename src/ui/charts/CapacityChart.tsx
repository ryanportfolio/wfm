import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { CapacityPlan } from '../../engine/capacity'
import type { ChartTheme } from '../theme'
import { tooltipStyle } from '../theme'

export function CapacityChart({ plan, theme }: { plan: CapacityPlan; theme: ChartTheme }) {
  return <div role="figure" aria-label="Required, baseline and proposed productive FTE over 13 weeks. Exact values are in the weekly table below.">
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={plan.weeks} margin={{ top: 12, right: 20, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis dataKey="week" stroke={theme.axis} /><YAxis stroke={theme.axis} width={55} />
        <Tooltip contentStyle={tooltipStyle(theme)} /><Legend />
        <Line dataKey="requiredProductiveFte" name="Required FTE" stroke={theme.actual} strokeDasharray="5 4" isAnimationActive={false} />
        <Line dataKey="baseline.productiveFte" name="Baseline FTE" stroke="#0072B2" isAnimationActive={false} />
        <Line dataKey="scenario.productiveFte" name="Proposed FTE" stroke="#009E73" strokeWidth={3} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>
}
