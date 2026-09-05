/**
 * Dedicated compute worker: runs the backtest, forecast, and staffing-grid
 * engines off the main thread so the UI stays interactive. The client
 * (src/ui/workerClient.ts) spawns it with
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
 * which Vite bundles into its own chunk that also works under base './'.
 *
 * The tsconfig compiles against the DOM lib, not WebWorker, so the worker
 * global scope is reached through a narrow local type instead of `self`
 * having the wrong shape.
 */
import type { WorkerRequest, WorkerResponse } from './workerProtocol'
import { runBacktest, runForecast } from './forecastPipeline'
import { applyScenario } from './staffing'
import { calculateIntraday } from './intraday'
import { errorMessage } from '../ui/errors'

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (msg: WorkerResponse) => void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (e) => {
  const msg = e.data
  try {
    switch (msg.kind) {
      case 'intraday': {
        scope.postMessage({ id: msg.id, kind: 'result', result: calculateIntraday(msg.points, msg.inputs, msg.config) })
        break
      }
      case 'backtest': {
        const result = runBacktest(msg.records, msg.queue, msg.opts, (fold, totalFolds) =>
          scope.postMessage({ id: msg.id, kind: 'progress', done: fold, total: totalFolds }),
        )
        scope.postMessage({ id: msg.id, kind: 'result', result })
        break
      }
      case 'forecast': {
        const result = runForecast(msg.records, msg.queue, msg.opts)
        scope.postMessage({ id: msg.id, kind: 'result', result })
        break
      }
      case 'staffing': {
        const result = applyScenario(msg.intervalForecast, msg.scenario, msg.baseConfig)
        scope.postMessage({ id: msg.id, kind: 'result', result })
        break
      }
    }
  } catch (err) {
    scope.postMessage({ id: msg.id, kind: 'error', message: errorMessage(err) })
  }
}
