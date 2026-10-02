import { afterEach, describe, expect, it, vi } from 'vitest'
import { historySeedInWorker } from './workerClient'
import { buildHistorySeed } from '../engine/capacitySeed'
import { addDays } from '../engine/series'
import type { IntervalRecord } from '../engine/types'
import type { WorkerRequest, WorkerResponse } from '../engine/workerProtocol'

const records: IntervalRecord[] = []
for (let d = '2025-01-06'; d <= '2025-02-02'; d = addDays(d, 1)) {
  records.push({ ts: `${d}T08:00`, queue: 'voice', offered: 20, aht: 300 }, { ts: `${d}T08:00`, queue: 'chat', offered: 5, aht: 600 })
}
const voice = records.filter(r => r.queue === 'voice')

class FakeWorker {
  static last: FakeWorker | null = null
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  postMessage = vi.fn<(msg: WorkerRequest) => void>()
  terminate = vi.fn()
  constructor() { FakeWorker.last = this }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('historySeedInWorker', () => {
  it('runs in-process without Worker support', async () => {
    expect(typeof Worker).toBe('undefined')
    await expect(historySeedInWorker(records, 'voice', '2025-02-03', 0.02)).resolves.toEqual(buildHistorySeed(voice, 'voice', '2025-02-03', 0.02))
    await expect(historySeedInWorker(records, 'voice', '2025-02-04', 0)).rejects.toThrow('Monday')
  })
  it('posts only the selected queue to the worker and resolves with its reply', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pending = historySeedInWorker(records, 'voice', '2025-02-03', 0.02)
    await Promise.resolve()
    const job = FakeWorker.last!
    const request = job.postMessage.mock.calls[0][0]
    expect(request).toMatchObject({ kind: 'historySeed', queue: 'voice', planStart: '2025-02-03', weeklyGrowth: 0.02 })
    expect(request.kind === 'historySeed' && request.records).toEqual(voice)
    job.onmessage!({ data: { id: request.id, kind: 'result', result: 'seed' } })
    await expect(pending).resolves.toBe('seed')
  })
})
