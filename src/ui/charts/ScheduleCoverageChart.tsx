import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { ScheduleRow } from '../../engine/schedule'
import type { ChartTheme } from '../theme'
import { CHART_FONT_SIZE, EXTRA_COLORS, tooltipStyle } from '../theme'
import { fmtNum } from '../format'

/** Okabe-Ito orange: agents scheduled above target. */
const OVER_COLOR = '#E69F00'

/**
 * Scheduled on-phone agents per interval against target and requirement.
 * Each bar stacks scheduled agents up to target (blue), agents above target
 * (orange) and the gap still missing below target (red, faded), so a bar
 * always reaches the larger of scheduled and target.
 */
export function ScheduleCoverageChart({ rows, theme }: { rows: readonly ScheduleRow[]; theme: ChartTheme }) {
  const data = rows.map(r => ({
    time: r.ts.slice(11, 16),
    covered: Math.min(r.scheduled, r.target),
    over: r.over,
    under: r.under,
    target: r.target,
    required: r.required,
  }))
  const names = {
    covered: 'Scheduled on phones, up to target',
    over: 'Overstaffed: above target',
    under: 'Understaffed: gap to target',
    target: 'Target (required after unplanned shrinkage)',
    required: 'Required on phones (Erlang)',
  }
  const legend = [
    { value: names.covered, kind: 'box', color: EXTRA_COLORS.staffing, opacity: 0.8 },
    { value: names.over, kind: 'box', color: OVER_COLOR, opacity: 0.9 },
    { value: names.under, kind: 'box', color: theme.bad, opacity: 0.4 },
    { value: names.target, kind: 'line', color: theme.text, dash: false },
    { value: names.required, kind: 'line', color: theme.axis, dash: true },
  ]
  const legendContent = () => (
    <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '4px 16px', paddingTop: 4 }}>
      {legend.map(e => (
        <span key={e.value} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {e.kind === 'line'
            ? <span style={{ width: 16, height: 0, borderTop: `2px ${e.dash ? 'dashed' : 'solid'} ${e.color}` }} />
            : <span style={{ width: 10, height: 10, background: e.color, opacity: e.opacity, borderRadius: 2 }} />}
          {e.value}
        </span>
      ))}
    </div>
  )
  return (
    <div role="figure" aria-label="Scheduled on-phone agents against target and requirement by interval. Exact values are in the interval coverage table.">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={1}>
          <CartesianGrid stroke={theme.grid} vertical={false} />
          <XAxis dataKey="time" tick={{ fill: theme.axis, fontSize: CHART_FONT_SIZE }} stroke={theme.grid} minTickGap={30} />
          <YAxis tick={{ fill: theme.axis, fontSize: CHART_FONT_SIZE }} stroke={theme.grid} width={44}
            label={{ value: 'Agents', angle: -90, position: 'insideLeft', fill: theme.axis, fontSize: CHART_FONT_SIZE }} />
          <Tooltip cursor={{ fill: theme.grid, fillOpacity: 0.35 }} contentStyle={tooltipStyle(theme)} labelStyle={{ color: theme.text }}
            formatter={(value, name) => [fmtNum(Number(value), 1), String(name)]} />
          <Legend wrapperStyle={{ fontSize: CHART_FONT_SIZE, color: theme.text }} content={legendContent} />
          <Bar dataKey="covered" name={names.covered} stackId="agents" fill={EXTRA_COLORS.staffing} fillOpacity={0.8} isAnimationActive={false} />
          <Bar dataKey="over" name={names.over} stackId="agents" fill={OVER_COLOR} fillOpacity={0.9} isAnimationActive={false} />
          <Bar dataKey="under" name={names.under} stackId="agents" fill={theme.bad} fillOpacity={0.4} isAnimationActive={false} />
          {/* Points sit at band centers; a centered step changes value halfway between them, at the bar edges. */}
          <Line type="step" dataKey="target" name={names.target} stroke={theme.text} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="step" dataKey="required" name={names.required} stroke={theme.axis} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
