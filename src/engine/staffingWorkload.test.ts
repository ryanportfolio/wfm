import { expect, it } from 'vitest'
import { parseCsv } from './csv'
import { runForecast } from './forecastPipeline'
import { addDays } from './series'
import { buildStaffingGrid, projectAtStaffing } from './staffing'
import { requiredAgents } from './erlang'
import { initialStaffing, parseProject, serializeProject } from '../ui/project'

it('rejects costly valid CSV/project forecasts through both staffing entry points', () => {
  const csv = 'timestamp,queue,offered,aht\n' + Array.from({ length: 28 }, (_, i) =>
    `${addDays('2026-01-05', i)}T08:00,voice,1,0.00000001`).join('\n')
  const parsed = parseCsv(csv)
  expect(parsed.errors).toEqual([])
  expect(parsed.records).toHaveLength(28)
  const project = parseProject(serializeProject({
    schema: 'wfm-project', version: 2, name: 'Tiny AHT', sourceLabel: 'tiny.csv',
    records: parsed.records, queue: 'voice', horizon: 7, staffing: initialStaffing(''),
    capacityByQueue: {}, intradayByQueue: {},
  }))
  const forecast = runForecast(project.records, 'voice', { horizonDays: 7 })
  expect(forecast.intervalForecast[0]).toEqual({ ts: '2026-02-02T08:00:00', offered: 1, aht: 1e-8 })
  const config = { mode: 'erlangA' as const, slPct: .8, slSeconds: 20, patienceSec: 120, shrinkage: .3, intervalSec: 1800 }
  expect(() => buildStaffingGrid(forecast.intervalForecast, undefined, config)).toThrow('supported workload')
  expect(() => requiredAgents('erlangA', 1, 1e-8, 1800, { pct: .8, seconds: 20 }, 120)).toThrow('seconds')
  expect(() => projectAtStaffing('erlangA', 1, 1e-8, 1800, 20, 1, 120)).toThrow('supported workload')
  expect(requiredAgents('erlangC', 1, 1e-8, 1800, { pct: .8, seconds: 20 }).bodies).toBe(1)
})
