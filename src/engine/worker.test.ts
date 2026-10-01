import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHistorySeed } from './capacitySeed'
import { addDays } from './series'
import type { IntervalRecord } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

const records: IntervalRecord[] = []
for (let d = '2025-01-06'; d <= '2025-02-02'; d = addDays(d, 1)) records.push({ ts: `${d}T08:00`, queue: 'voice', offered: 20, aht: 300 })

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { onmessage?: unknown }).onmessage
})

describe('compute worker', () => {
  it('answers a historySeed request with the engine seed, and a bad plan start with an error', async () => {
    const posted: WorkerResponse[] = []
    vi.stubGlobal('postMessage', (msg: WorkerResponse) => posted.push(msg))
    await import('./worker')
    const scope = globalThis as unknown as { onmessage: (e: { data: WorkerRequest }) => void }
    scope.onmessage({ data: { id: 7, kind: 'historySeed', records, queue: 'voice', planStart: '2025-02-03', weeklyGrowth: 0.01 } })
    expect(posted).toEqual([{ id: 7, kind: 'result', result: buildHistorySeed(records, 'voice', '2025-02-03', 0.01) }])
    scope.onmessage({ data: { id: 8, kind: 'historySeed', records, queue: 'voice', planStart: '2025-02-04', weeklyGrowth: 0 } })
    expect(posted[1]).toEqual({ id: 8, kind: 'error', message: 'Plan start must be a real ISO date on a Monday.' })
  })
})
