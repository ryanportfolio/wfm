import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { CapacityPlan } from '../../engine/capacity'
import type { ChartTheme } from '../theme'
import { CHART_FONT_SIZE, tooltipStyle } from '../theme'
import { classMilestones } from '../capacityState'

export function CapacityChart({ plan, theme }: { plan: CapacityPlan; theme: ChartTheme }) {
  const milestones = classMilestones(plan)
  // One line per week; labels of classes sharing a week are joined.
  const markers = new Map<number, string[]>()
  const mark = (week: number, text: string) => markers.set(week, [...(markers.get(week) ?? []), text])
  for (const m of milestones) {
    mark(m.start, `C${m.classNumber} start`)
    if (m.production !== null) mark(m.production, `C${m.classNumber} prod`)
  }
  const described = milestones.map(m => `class ${m.classNumber} starts week ${m.start}, production ${m.production === null ? 'after week 13' : `from week ${m.production}`}`)
  const label = 'Required, baseline and proposed productive FTE over 13 weeks.'
    + (described.length ? ` Hiring class markers: ${described.join('; ')}.` : '')
    + ' Exact values are in the weekly table below.'
  return <div role="figure" aria-label={label}>
    <ResponsiveContainer width="100%" height={300}>
      {/* Marker labels sit in a band above the plot area, two rows deep, so they never cross data lines. */}
      <LineChart data={plan.weeks} margin={{ top: markers.size ? 44 : 12, right: markers.size ? 36 : 20, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={theme.grid} vertical={false} />
        <XAxis dataKey="week" stroke={theme.axis} /><YAxis stroke={theme.axis} width={55} />
        <Tooltip contentStyle={tooltipStyle(theme)} /><Legend />
        {[...markers].sort((a, b) => a[0] - b[0]).map(([week, texts], i) => <ReferenceLine key={week} x={week} stroke={theme.axis} strokeDasharray="4 4"
          label={{ value: texts.join(', '), position: 'top', offset: 6 + (i % 2) * 16, fill: theme.axis, fontSize: CHART_FONT_SIZE - 1, className: 'capacity-marker-label' }} />)}
        <Line dataKey="requiredProductiveFte" name="Required FTE" stroke={theme.actual} strokeDasharray="5 4" isAnimationActive={false} />
        <Line dataKey="baseline.productiveFte" name="Baseline FTE" stroke="#0072B2" isAnimationActive={false} />
        <Line dataKey="scenario.productiveFte" name="Proposed FTE" stroke="#009E73" strokeWidth={3} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>
}
