import { afterEach, describe, expect, it, vi } from 'vitest'
import { intradayInWorker } from './workerClient'
import type { WorkerResponse } from '../engine/workerProtocol'
import type { StaffingConfig } from '../engine/staffing'

class FakeWorker {
  static jobs: FakeWorker[] = []
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.jobs.push(this) }
}
const config: StaffingConfig = { mode: 'erlangC', slPct: .8, slSeconds: 20, patienceSec: 120, shrinkage: .3, intervalSec: 1800 }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWorker.jobs = [] })
describe('isolated intraday worker', () => {
  it('terminates superseded work without affecting a newer independent job', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const first = new AbortController(), second = new AbortController()
    const a = intradayInWorker([], { cutoff: 0, actuals: {}, scheduled: {} }, config, first.signal)
    const b = intradayInWorker([], { cutoff: 0, actuals: {}, scheduled: {} }, config, second.signal)
    const rejected = expect(a).rejects.toThrow('cancelled')
    first.abort(); await rejected
    expect(FakeWorker.jobs[0].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.jobs[1].terminate).not.toHaveBeenCalled()
    FakeWorker.jobs[1].onmessage!({ data: { id: 1, kind: 'result', result: { rows: [] } } })
    await expect(b).resolves.toEqual({ rows: [] })
    expect(FakeWorker.jobs[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intraday' }))
    expect(FakeWorker.jobs[1].terminate).toHaveBeenCalledOnce()
  })
  it('times out at 10 seconds and frees the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers()
    const p = intradayInWorker([], { cutoff: 0, actuals: {}, scheduled: {} }, config, new AbortController().signal)
    const rejected = expect(p).rejects.toThrow('exceeded 10 seconds')
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    expect(FakeWorker.jobs[0].terminate).toHaveBeenCalledOnce()
  })
  it('returns engine results through fallback without Worker', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(intradayInWorker([], { cutoff: 0, actuals: {}, scheduled: {} }, config, new AbortController().signal)).resolves.toMatchObject({ revisedTotal: 0, rows: [] })
  })
})
