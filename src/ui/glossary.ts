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
      'Average handle time: the seconds an agent spends per contact, talk plus wrap-up. An AHT of 300 s means a typical contact takes 5 minutes of agent time.',
  },
  wape: {
    label: 'WAPE',
    definition:
      'Weighted absolute percentage error: total absolute forecast miss divided by total actual volume. 10% WAPE over a 10,000-contact week means the forecast missed by about 1,000 contacts in total.',
  },
  mape: {
    label: 'MAPE',
    definition:
      'Mean absolute percentage error: the percentage miss at each point, averaged with equal weight. A quiet interval counts as much as a busy one, so a few tiny actuals can inflate it.',
  },
  asa: {
    label: 'ASA',
    definition:
      'Average speed of answer: the mean wait before an agent picks up. An ASA of 25 s means the typical contact waited 25 seconds.',
  },
  sl: {
    label: 'SL',
    definition:
      'Service level: the share of contacts answered within the target time. An 80/20 target means 80% answered within 20 seconds.',
  },
  fte: {
    label: 'FTE-hours',
    definition:
      'Full-time equivalent hours: one FTE-hour is one person staffed for one hour. 96 scheduled FTE-hours in a day is 12 people on 8-hour shifts.',
  },
  mad: {
    label: 'MAD',
    definition:
      'Median absolute deviation: the median of how far each value sits from the group median. One extreme value barely moves it, which makes it a steady yardstick for spotting outliers.',
  },
  shrinkage: {
    label: 'Shrinkage',
    definition:
      'The share of paid time an agent is not available for contacts: breaks, meetings, training. 30% shrinkage means you must schedule 10 hours to get 7 on the queue.',
  },
  occupancy: {
    label: 'Occupancy',
    definition:
      'The share of logged-in time an agent spends handling contacts instead of waiting for one. 90% occupancy leaves 6 idle minutes per hour; teams rarely sustain more without burning out.',
  },
  rollingOrigin: {
    label: 'Rolling-origin',
    definition:
      'A backtest that refits the forecast at several past cut-off dates (origins) and scores each refit on the days after its cut-off, so every score comes from data the model had not seen.',
  },
  dhr: {
    label: 'DHR',
    definition:
      'Dynamic harmonic regression: a model that fits sine and cosine waves at weekly and yearly cycle lengths, plus a trend, so it tracks smooth repeating seasonal shapes.',
  },
  erlang: {
    label: 'Erlang A vs C',
    definition:
      'Two queueing formulas that turn volume and AHT into agents needed. Erlang C assumes every caller waits forever; Erlang A lets callers hang up when their patience runs out, which usually needs slightly fewer agents for the same target.',
  },
  meanPatience: {
    label: 'Mean patience',
    definition:
      'The average time a caller will wait before giving up. Erlang A uses it to estimate abandonment: shorter patience means more hang-ups at the same staffing.',
  },
  abandonment: {
    label: 'Abandonment',
    definition:
      'The share of contacts that hang up before reaching an agent. 5% abandonment on 2,000 daily calls is 100 callers who gave up waiting.',
  },
  offered: {
    label: 'Offered volume',
    definition:
      'Contacts that arrived and asked for service, answered or not. Staffing plans on offered volume because abandoned callers still needed an agent.',
  },
  horizonBucket: {
    label: 'Horizon bucket',
    definition:
      'A range of forecast lead days grouped together, such as days 1 to 7. Blend weights are fitted per bucket because the best method one day out is often not the best three weeks out.',
  },
} as const satisfies Record<string, GlossaryEntry>

export type TermKey = keyof typeof GLOSSARY
