/**
 * Plain-language definitions for every WFM and forecasting term the UI uses.
 * One module so the copy stays identical everywhere a term appears.
 */

export interface GlossaryEntry {
  /** Default display text when <Term> is given no children. */
  label: string
  /** One-to-two sentence plain-language definition. */
  definition: string
}

export const GLOSSARY = {
  aht: {
    label: 'AHT',
    definition:
      'Average handle time: agent seconds per contact, talk plus wrap-up; 300 s is 5 minutes.',
  },
  ensemble: {
    label: 'Ensemble',
    definition:
      'Several methods blended, weighted toward the most accurate; usually beats any one.',
  },
  wape: {
    label: 'WAPE',
    definition:
      'Weighted absolute percentage error: total absolute miss over total actuals; 10% of a 10,000-contact week is about 1,000.',
  },
  mape: {
    label: 'MAPE',
    definition:
      'Mean absolute percentage error: per-point miss averaged equally, so quiet intervals count like busy ones and tiny actuals inflate it.',
  },
  asa: {
    label: 'ASA',
    definition:
      'Average speed of answer: mean wait before pickup.',
  },
  sl: {
    label: 'SL',
    definition:
      'Service level: share answered within target time; 80/20 means 80% within 20 seconds.',
  },
  fte: {
    label: 'FTE-hours',
    definition:
      'Full-time equivalent hours: one person, one hour; 96 a day is 12 people on 8-hour shifts.',
  },
  mad: {
    label: 'MAD',
    definition:
      'Median absolute deviation: median distance from the group median; one extreme value barely moves it, so it spots outliers reliably.',
  },
  shrinkage: {
    label: 'Shrinkage',
    definition:
      'Paid time not spent on contacts (breaks, meetings, training); at 30%, 10 scheduled hours give 7 on the queue.',
  },
  occupancy: {
    label: 'Occupancy',
    definition:
      'Logged-in time on contacts, not waiting; 90% leaves 6 idle minutes an hour; teams rarely sustain more without burnout.',
  },
  rollingOrigin: {
    label: 'Rolling-origin',
    definition:
      'Backtest refit at several past cut-offs (origins), each scored on the days after; no score uses seen data.',
  },
  dhr: {
    label: 'DHR',
    definition:
      'Dynamic harmonic regression: weekly and yearly sine and cosine waves plus a trend.',
  },
  erlang: {
    label: 'Erlang A vs C',
    definition:
      'Formulas turning volume and AHT into agents. Erlang C assumes callers never hang up; Erlang A lets them, usually needing slightly fewer for the same target.',
  },
  meanPatience: {
    label: 'Mean patience',
    definition:
      'Average wait before giving up, which Erlang A turns into abandonment: shorter patience, more hang-ups at the same staffing.',
  },
  abandonment: {
    label: 'Abandonment',
    definition:
      'Share hanging up before reaching an agent; 5% of 2,000 daily calls is 100 callers.',
  },
  offered: {
    label: 'Offered volume',
    definition:
      'Contacts that arrived, answered or not; staffing uses it since abandoned callers still needed an agent.',
  },
  horizonBucket: {
    label: 'Horizon bucket',
    definition:
      'Grouped lead days, such as 1 to 7, each with its own blend weights: the best method one day out often differs three weeks out.',
  },
} as const satisfies Record<string, GlossaryEntry>

export type TermKey = keyof typeof GLOSSARY
