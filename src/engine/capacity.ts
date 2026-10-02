/** A 13-week planning model. Demand is productive FTE, before shrinkage gross-up. */
export const CAPACITY_WEEKS = 13

/** Bounds keep inputs practical and all aggregate costs below Number.MAX_SAFE_INTEGER. */
export const CAPACITY_LIMITS = {
  headcount: 1_000_000,
  requiredProductiveFte: 1_000_000,
  paidHoursPerWeek: 168,
  hourlyCost: 100_000,
  durationWeeks: 52,
  hiringClasses: 12,
} as const

export interface HiringClass {
  /** Zero disables the class. Fractional heads are expected planning values. */
  size: number
  startWeek: number
  trainingWeeks: number
  /** Weeks after training at nestingProductivity; zero skips nesting. */
  nestingWeeks: number
  /** Productive share of a nesting head, 0..1. Ignored when nestingWeeks is 0. */
  nestingProductivity: number
  rampWeeks: number
}

export interface CapacityConfig {
  requiredProductiveFte: readonly number[]
  startingHeadcount: number
  /** Tenured rate, applied to existing heads only. */
  weeklyAttrition: number
  /** Applied to every hire cohort in every phase, for all 13 weeks. */
  newHireWeeklyAttrition: number
  /** Defines the paid workweek for cost; a productive FTE uses this same workweek. */
  paidHoursPerWeek: number
  shrinkage: number
  hourlyCost: number
  hiringClasses: readonly HiringClass[]
}

export type HiringPhase = 'pending' | 'training' | 'nesting' | 'ramp' | 'productive'

export interface HiringClassWeek {
  phase: HiringPhase
  /** Surviving expected heads; zero before the start week. */
  headcount: number
  /** Productive share per head, 0..1, before shrinkage. */
  productivity: number
}

export interface CapacitySupply {
  existingHeadcount: number
  hireHeadcount: number
  /** Sum of surviving hires times their productivity, before shrinkage. */
  hireProductiveHeads: number
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
  /** One entry per configured hiring class, in input order. */
  classes: HiringClassWeek[]
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
  bounded(input.newHireWeeklyAttrition, 'newHireWeeklyAttrition', 1)
  bounded(input.paidHoursPerWeek, 'paidHoursPerWeek', CAPACITY_LIMITS.paidHoursPerWeek)
  if (!(Number(input.paidHoursPerWeek) > 0)) throw new RangeError('paidHoursPerWeek must be greater than 0')
  bounded(input.shrinkage, 'shrinkage', 1)
  bounded(input.hourlyCost, 'hourlyCost', CAPACITY_LIMITS.hourlyCost)
  const classes = input.hiringClasses
  if (!Array.isArray(classes) || classes.length > CAPACITY_LIMITS.hiringClasses) {
    throw new RangeError(`hiringClasses must be an array of at most ${CAPACITY_LIMITS.hiringClasses} classes`)
  }
  for (let i = 0; i < classes.length; i++) {
    const hiring: unknown = classes[i]
    const label = `hiringClasses[${i}]`
    if (!record(hiring)) throw new TypeError(`${label} must be an object`)
    bounded(hiring.size, `${label}.size`, CAPACITY_LIMITS.headcount)
    bounded(hiring.startWeek, `${label}.startWeek`, CAPACITY_WEEKS, true, 1)
    bounded(hiring.trainingWeeks, `${label}.trainingWeeks`, CAPACITY_LIMITS.durationWeeks, true)
    bounded(hiring.nestingWeeks, `${label}.nestingWeeks`, CAPACITY_LIMITS.durationWeeks, true)
    bounded(hiring.nestingProductivity, `${label}.nestingProductivity`, 1)
    bounded(hiring.rampWeeks, `${label}.rampWeeks`, CAPACITY_LIMITS.durationWeeks, true)
  }
}

function supply(config: CapacityConfig, demand: number, existing: number, hires: number, productiveHires: number): CapacitySupply {
  const paidHeadcount = existing + hires
  const paidHours = paidHeadcount * config.paidHoursPerWeek
  const productiveFte = (existing + productiveHires) * (1 - config.shrinkage)
  const difference = productiveFte - demand
  const tolerance = 32 * Number.EPSILON * Math.max(1, productiveFte, demand)
  const balanceFte = Math.abs(difference) <= tolerance ? 0 : difference
  return {
    existingHeadcount: existing, hireHeadcount: hires, hireProductiveHeads: productiveHires,
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
 * Phase and productivity of one class in its k-th week after arrival (k = 1 is the start week).
 * Ramp week j of R supplies p + (1 - p) * j / R, where p is nesting productivity, or 0 without nesting,
 * so a class without nesting ramps 1/R, 2/R, ... 1.
 */
function classWeek(hiring: HiringClass, k: number, headcount: number): HiringClassWeek {
  const nestingEnd = hiring.trainingWeeks + hiring.nestingWeeks
  const start = hiring.nestingWeeks > 0 ? hiring.nestingProductivity : 0
  if (k <= 0) return { phase: 'pending', headcount, productivity: 0 }
  if (k <= hiring.trainingWeeks) return { phase: 'training', headcount, productivity: 0 }
  if (k <= nestingEnd) return { phase: 'nesting', headcount, productivity: hiring.nestingProductivity }
  if (k <= nestingEnd + hiring.rampWeeks) {
    return { phase: 'ramp', headcount, productivity: start + (1 - start) * (k - nestingEnd) / hiring.rampWeeks }
  }
  return { phase: 'productive', headcount, productivity: 1 }
}

function computePlan(config: CapacityConfig): CapacityPlan {
  const weeks: CapacityWeek[] = []
  let existing = config.startingHeadcount
  const heads = config.hiringClasses.map(() => 0)
  for (let week = 1; week <= CAPACITY_WEEKS; week++) {
    if (week > 1) existing *= 1 - config.weeklyAttrition
    const classes = config.hiringClasses.map((hiring, i) => {
      if (week === hiring.startWeek) heads[i] = hiring.size
      else if (week > hiring.startWeek) heads[i] *= 1 - config.newHireWeeklyAttrition
      return classWeek(hiring, week - hiring.startWeek + 1, heads[i])
    })
    const hires = classes.reduce((sum, c) => sum + c.headcount, 0)
    const productiveHires = classes.reduce((sum, c) => sum + c.headcount * c.productivity, 0)
    const demand = config.requiredProductiveFte[week - 1]
    const baseline = supply(config, demand, existing, 0, 0)
    const scenario = supply(config, demand, existing, hires, productiveHires)
    weeks.push({
      week, requiredProductiveFte: demand, baseline, scenario, classes,
      incrementalProductiveFte: scenario.productiveFte - baseline.productiveFte,
      incrementalCost: scenario.cost - baseline.cost,
    })
  }
  const baseline = summarize(weeks, 'baseline')
  const scenario = summarize(weeks, 'scenario')
  return { weeks, baseline, scenario, incrementalCost: scenario.totalCost - baseline.totalCost }
}

/**
 * Existing heads are present in week 1 and attrit at the tenured rate from week 2.
 * Each hiring class is an independent cohort, paid from its start week and attrited at the
 * new-hire rate every later week in every phase. Simplification: hires keep the new-hire rate
 * for all 13 weeks, even after reaching full productivity.
 * Per class: training weeks supply zero; nesting weeks supply survivors x nesting productivity;
 * ramp weeks rise linearly to 100% (see classWeek); zero ramp means full productivity next.
 * Shrinkage applies once, to supply only. Costs remain unrounded.
 */
export function buildCapacityPlan(config: CapacityConfig): CapacityPlan {
  validateCapacityConfig(config)
  return computePlan(config)
}

/** Demand moves +/-10% in every week. */
export const SENSITIVITY_DEMAND_CHANGE = 0.1
/** Tenured weekly attrition moves +/-5 percentage points, clamped to 0..100%. */
export const SENSITIVITY_ATTRITION_POINTS = 0.05
/** Shrinkage moves +/-5 percentage points, clamped to 0..99%. */
export const SENSITIVITY_SHRINKAGE_POINTS = 0.05
export const SENSITIVITY_SHRINKAGE_MAX = 0.99
/** Every class size moves +/-20%, changing total new hires by the same share. */
export const SENSITIVITY_HIRE_SIZE_CHANGE = 0.2

export type SensitivityLever = 'demand' | 'tenuredAttrition' | 'shrinkage' | 'newHireSize'

export interface SensitivityRow {
  lever: SensitivityLever
  direction: 'down' | 'up'
  /** Adjusted value: a demand or hire-size multiplier, or the clamped attrition or shrinkage rate. */
  value: number
  /** Proposal results with the lever applied. */
  scenario: CapacitySummary
  /** Lever minus unchanged proposal. Null when either plan has no shortage week. */
  firstShortageWeekDelta: number | null
  totalShortageFteWeeksDelta: number
  totalCostDelta: number
}

export interface CapacitySensitivity {
  /** Unchanged proposal results. */
  scenario: CapacitySummary
  rows: SensitivityRow[]
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * One-at-a-time levers applied to the proposal (scenario) plan, each in both directions.
 * Shrinkage clamps to 0..99%; an entered value above 99% stays as the upper bound so the up lever never lowers it.
 */
export function capacitySensitivity(config: CapacityConfig): CapacitySensitivity {
  validateCapacityConfig(config)
  const base = computePlan(config).scenario
  const levers: Record<SensitivityLever, (sign: number) => [number, CapacityConfig]> = {
    demand: sign => {
      const scale = 1 + sign * SENSITIVITY_DEMAND_CHANGE
      return [scale, { ...config, requiredProductiveFte: config.requiredProductiveFte.map(v => v * scale) }]
    },
    tenuredAttrition: sign => {
      const weeklyAttrition = clamp(config.weeklyAttrition + sign * SENSITIVITY_ATTRITION_POINTS, 0, 1)
      return [weeklyAttrition, { ...config, weeklyAttrition }]
    },
    shrinkage: sign => {
      const shrinkage = clamp(config.shrinkage + sign * SENSITIVITY_SHRINKAGE_POINTS, 0, Math.max(SENSITIVITY_SHRINKAGE_MAX, config.shrinkage))
      return [shrinkage, { ...config, shrinkage }]
    },
    newHireSize: sign => {
      const scale = 1 + sign * SENSITIVITY_HIRE_SIZE_CHANGE
      return [scale, { ...config, hiringClasses: config.hiringClasses.map(c => ({ ...c, size: c.size * scale })) }]
    },
  }
  const rows: SensitivityRow[] = []
  for (const lever of Object.keys(levers) as SensitivityLever[]) {
    for (const direction of ['down', 'up'] as const) {
      const [value, adjusted] = levers[lever](direction === 'down' ? -1 : 1)
      const scenario = computePlan(adjusted).scenario
      rows.push({
        lever, direction, value, scenario,
        firstShortageWeekDelta: scenario.firstShortageWeek === null || base.firstShortageWeek === null
          ? null : scenario.firstShortageWeek - base.firstShortageWeek,
        totalShortageFteWeeksDelta: scenario.totalShortageFteWeeks - base.totalShortageFteWeeks,
        totalCostDelta: scenario.totalCost - base.totalCost,
      })
    }
  }
  return { scenario: base, rows }
}
