/** A 13-week planning model. Demand is productive FTE, before shrinkage gross-up. */
export const CAPACITY_WEEKS = 13

/** Bounds keep inputs practical and all aggregate costs below Number.MAX_SAFE_INTEGER. */
export const CAPACITY_LIMITS = {
  headcount: 1_000_000,
  requiredProductiveFte: 1_000_000,
  paidHoursPerWeek: 168,
  hourlyCost: 100_000,
  durationWeeks: 52,
} as const

export interface HiringClass {
  /** Zero disables the class. Fractional heads are expected planning values. */
  size: number
  startWeek: number
  trainingWeeks: number
  rampWeeks: number
}

export interface CapacityConfig {
  requiredProductiveFte: readonly number[]
  startingHeadcount: number
  weeklyAttrition: number
  /** Defines the paid workweek for cost; a productive FTE uses this same workweek. */
  paidHoursPerWeek: number
  shrinkage: number
  hourlyCost: number
  hiringClass: HiringClass
}

export interface CapacitySupply {
  existingHeadcount: number
  hireHeadcount: number
  hireProductivity: number
  paidHeadcount: number
  paidHours: number
  productiveFte: number
  /** Productive supply minus required FTE; positive means surplus. */
  balanceFte: number
  shortageFte: number
  surplusFte: number
  cost: number
}

export interface CapacityWeek {
  week: number
  requiredProductiveFte: number
  baseline: CapacitySupply
  scenario: CapacitySupply
  incrementalProductiveFte: number
  incrementalCost: number
}

export interface CapacitySummary {
  firstShortageWeek: number | null
  totalCost: number
  totalShortageFteWeeks: number
}

export interface CapacityPlan {
  weeks: CapacityWeek[]
  baseline: CapacitySummary
  scenario: CapacitySummary
  incrementalCost: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(value: unknown, field: string, max: number, integer = false, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${field} must be a finite ${integer ? 'integer' : 'number'} between ${min} and ${max}`)
  }
}

/** Also validates parsed JSON before it enters a saved project or the model. */
export function validateCapacityConfig(input: unknown): asserts input is CapacityConfig {
  if (!record(input)) throw new TypeError('Capacity settings must be an object')
  const demand = input.requiredProductiveFte
  if (!Array.isArray(demand) || demand.length !== CAPACITY_WEEKS) {
    throw new RangeError('requiredProductiveFte must contain exactly 13 weeks')
  }
  // Indexed access deliberately rejects sparse arrays as well as invalid values.
  for (let i = 0; i < CAPACITY_WEEKS; i++) {
    bounded(demand[i], `requiredProductiveFte[${i}]`, CAPACITY_LIMITS.requiredProductiveFte)
  }
  bounded(input.startingHeadcount, 'startingHeadcount', CAPACITY_LIMITS.headcount)
  bounded(input.weeklyAttrition, 'weeklyAttrition', 1)
  bounded(input.paidHoursPerWeek, 'paidHoursPerWeek', CAPACITY_LIMITS.paidHoursPerWeek)
  if (!(Number(input.paidHoursPerWeek) > 0)) throw new RangeError('paidHoursPerWeek must be greater than 0')
  bounded(input.shrinkage, 'shrinkage', 1)
  bounded(input.hourlyCost, 'hourlyCost', CAPACITY_LIMITS.hourlyCost)
  const hiring = input.hiringClass
  if (!record(hiring)) throw new TypeError('hiringClass must be an object')
  bounded(hiring.size, 'hiringClass.size', CAPACITY_LIMITS.headcount)
  bounded(hiring.startWeek, 'hiringClass.startWeek', CAPACITY_WEEKS, true, 1)
  bounded(hiring.trainingWeeks, 'hiringClass.trainingWeeks', CAPACITY_LIMITS.durationWeeks, true)
  bounded(hiring.rampWeeks, 'hiringClass.rampWeeks', CAPACITY_LIMITS.durationWeeks, true)
}

function supply(config: CapacityConfig, demand: number, existing: number, hires: number, productivity: number): CapacitySupply {
  const paidHeadcount = existing + hires
  const paidHours = paidHeadcount * config.paidHoursPerWeek
  const productiveFte = (existing + hires * productivity) * (1 - config.shrinkage)
  const difference = productiveFte - demand
  const tolerance = 32 * Number.EPSILON * Math.max(1, productiveFte, demand)
  const balanceFte = Math.abs(difference) <= tolerance ? 0 : difference
  return {
    existingHeadcount: existing, hireHeadcount: hires, hireProductivity: productivity,
    paidHeadcount, paidHours, productiveFte, balanceFte,
    shortageFte: Math.max(0, -balanceFte), surplusFte: Math.max(0, balanceFte),
    cost: paidHours * config.hourlyCost,
  }
}

function summarize(weeks: CapacityWeek[], which: 'baseline' | 'scenario'): CapacitySummary {
  return {
    firstShortageWeek: weeks.find(row => row[which].shortageFte > 0)?.week ?? null,
    totalCost: weeks.reduce((sum, row) => sum + row[which].cost, 0),
    totalShortageFteWeeks: weeks.reduce((sum, row) => sum + row[which].shortageFte, 0),
  }
}

/**
 * Existing heads are present in week 1. Attrition begins in week 2.
 * Hires are paid on arrival, then attrit each following week including training.
 * Full training weeks supply zero capacity; ramp weeks contribute 1/N, 2/N, ... 1.
 * Shrinkage applies once, to supply only. Costs remain unrounded.
 */
export function buildCapacityPlan(config: CapacityConfig): CapacityPlan {
  validateCapacityConfig(config)
  const weeks: CapacityWeek[] = []
  const hiring = config.hiringClass
  let existing = config.startingHeadcount
  let hires = 0
  for (let week = 1; week <= CAPACITY_WEEKS; week++) {
    if (week > 1) existing *= 1 - config.weeklyAttrition
    if (week === hiring.startWeek) hires = hiring.size
    else if (week > hiring.startWeek) hires *= 1 - config.weeklyAttrition
    const productiveWeek = week - hiring.startWeek - hiring.trainingWeeks + 1
    const productivity = hires === 0 || productiveWeek <= 0 ? 0
      : hiring.rampWeeks === 0 ? 1 : Math.min(1, productiveWeek / hiring.rampWeeks)
    const demand = config.requiredProductiveFte[week - 1]
    const baseline = supply(config, demand, existing, 0, 0)
    const scenario = supply(config, demand, existing, hires, productivity)
    weeks.push({
      week, requiredProductiveFte: demand, baseline, scenario,
      incrementalProductiveFte: scenario.productiveFte - baseline.productiveFte,
      incrementalCost: scenario.cost - baseline.cost,
    })
  }
  const baseline = summarize(weeks, 'baseline')
  const scenario = summarize(weeks, 'scenario')
  return { weeks, baseline, scenario, incrementalCost: scenario.totalCost - baseline.totalCost }
}
