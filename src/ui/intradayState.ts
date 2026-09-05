import type { IntradayInputs } from '../engine/intraday'

export interface IntradayState {
  selectedDay: string | null
  days: Record<string, IntradayInputs>
}
export const emptyIntradayState = (): IntradayState => ({ selectedDay: null, days: {} })
export const emptyIntradayInputs = (): IntradayInputs => ({ cutoff: 0, actuals: {}, scheduled: {} })
