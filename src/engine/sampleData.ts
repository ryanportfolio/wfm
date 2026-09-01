import type { IntervalRecord } from './types'
import { civilFromDays, dayNumFromIso, daysFromCivil, isoFromDayNum, weekdayOfDayNum } from './series'
import { usHolidays } from './holidays'

export const SAMPLE_START = '2024-08-17'
export const SAMPLE_END = '2026-08-16'
export const SAMPLE_QUEUES = ['voice-benefits', 'voice-claims', 'chat-support'] as const

const SEED = 0x5f3d2024
const INTERVALS_PER_DAY = 48
const OPEN_SLOT = 16 // 08:00
const CLOSE_SLOT = 40 // 20:00

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeNormal(rng: () => number): () => number {
  return () => {
    const u1 = 1 - rng()
    const u2 = rng()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

/** Marsaglia-Tsang, shape >= 1 */
function gammaSample(rng: () => number, normal: () => number, shape: number, scale: number): number {
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
  }
}

function poissonSample(rng: () => number, normal: () => number, lambda: number): number {
  if (lambda <= 0) return 0
  if (lambda < 30) {
    const limit = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= rng()
    } while (p > limit)
    return k - 1
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()))
}

interface QueueConfig {
  name: string
  baseDaily: number
  weekdayFactor: number[] // index 0 = Sunday
  monthBump: number // first 3 business days of the month
  spikeWeight: number // share of the post-holiday spike this queue feels
  dispersion: number // gamma shape; lower = noisier
  ahtBase: number
  intradayShape: (t: number) => number // t = hour-of-day midpoint
}

const voiceIntraday = (t: number): number =>
  0.18 + Math.exp(-((t - 10) ** 2) / (2 * 1.1 ** 2)) + 0.85 * Math.exp(-((t - 14) ** 2) / (2 * 1.4 ** 2))

const chatIntraday = (t: number): number => 0.75 + 0.35 * Math.exp(-((t - 13) ** 2) / (2 * 3 ** 2))

const QUEUE_CONFIGS: QueueConfig[] = [
  {
    name: 'voice-benefits',
    baseDaily: 2600,
    weekdayFactor: [0.35, 1.35, 1.15, 1.05, 1.0, 0.95, 0.45],
    monthBump: 1.28,
    spikeWeight: 1,
    dispersion: 12,
    ahtBase: 420,
    intradayShape: voiceIntraday,
  },
  {
    name: 'voice-claims',
    baseDaily: 1300,
    weekdayFactor: [0.35, 1.3, 1.15, 1.05, 1.0, 0.95, 0.45],
    monthBump: 1.12,
    spikeWeight: 1,
    dispersion: 12,
    ahtBase: 435,
    intradayShape: voiceIntraday,
  },
  {
    name: 'chat-support',
    baseDaily: 550,
    weekdayFactor: [0.8, 1.1, 1.05, 1.0, 1.0, 0.95, 0.85],
    monthBump: 1.02,
    spikeWeight: 0.5,
    dispersion: 10,
    ahtBase: 600,
    intradayShape: chatIntraday,
  },
]

function normalizedShares(shape: (t: number) => number): number[] {
  const raw: number[] = []
  for (let slot = OPEN_SLOT; slot < CLOSE_SLOT; slot++) {
    const t = slot / 2 + 0.25
    raw.push(shape(t))
  }
  const sum = raw.reduce((a, b) => a + b, 0)
  return raw.map((w) => w / sum)
}

const SLOT_TIMES = Array.from({ length: INTERVALS_PER_DAY }, (_, slot) => {
  const h = String(Math.floor(slot / 2)).padStart(2, '0')
  const m = slot % 2 === 0 ? '00' : '30'
  return `T${h}:${m}:00`
})

interface DayContext {
  iso: string
  weekday: number
  holiday: boolean
  monthBump: boolean
  spikeFactor: number
  yearly: number
  trend: number
  voiceShock: number
  chatShock: number
}

function buildDayContexts(rng: () => number, normal: () => number): DayContext[] {
  const startNum = dayNumFromIso(SAMPLE_START)
  const endNum = dayNumFromIso(SAMPLE_END)
  const holidaySet = new Set(usHolidays(SAMPLE_START, SAMPLE_END))

  const spikeByDate = new Map<string, number>()
  for (const h of [...holidaySet].sort()) {
    let z = dayNumFromIso(h) + 1
    while (weekdayOfDayNum(z) === 0 || weekdayOfDayNum(z) === 6 || holidaySet.has(isoFromDayNum(z))) {
      z++
    }
    if (z <= endNum) {
      const factor = 1.25 + rng() * 0.15
      const iso = isoFromDayNum(z)
      spikeByDate.set(iso, Math.max(spikeByDate.get(iso) ?? 1, factor))
    }
  }

  const days: DayContext[] = []
  let businessDaysThisMonth = 0
  let currentMonth = -1
  for (let z = startNum; z <= endNum; z++) {
    const civil = civilFromDays(z)
    const iso = isoFromDayNum(z)
    const weekday = weekdayOfDayNum(z)
    const holiday = holidaySet.has(iso)
    if (civil.m !== currentMonth) {
      currentMonth = civil.m
      businessDaysThisMonth = 0
    }
    const isBusiness = weekday >= 1 && weekday <= 5 && !holiday
    if (isBusiness) businessDaysThisMonth++
    const doy = z - daysFromCivil(civil.y, 1, 1)
    days.push({
      iso,
      weekday,
      holiday,
      monthBump: isBusiness && businessDaysThisMonth <= 3,
      spikeFactor: spikeByDate.get(iso) ?? 1,
      yearly: 1 + 0.06 * Math.cos((2 * Math.PI * (doy - 15)) / 365.25),
      trend: 1 + 0.1 * ((z - startNum) / (endNum - startNum)),
      voiceShock: Math.exp(normal() * 0.06),
      chatShock: Math.exp(normal() * 0.05),
    })
  }
  return days
}

/**
 * Deterministic 2-year, 3-queue, 30-minute sample dataset for a public-sector
 * contact center. Same output on every call and every machine.
 */
export function generateSampleData(): IntervalRecord[] {
  const rng = mulberry32(SEED)
  const normal = makeNormal(rng)
  const days = buildDayContexts(rng, normal)
  const records: IntervalRecord[] = []

  for (const config of QUEUE_CONFIGS) {
    const shares = normalizedShares(config.intradayShape)
    for (const day of days) {
      const voiceLike = config.name.startsWith('voice')
      const shock = voiceLike ? day.voiceShock : day.chatShock
      const dailyMean = day.holiday
        ? 0
        : config.baseDaily *
          config.weekdayFactor[day.weekday] *
          day.yearly *
          day.trend *
          (day.monthBump ? config.monthBump : 1) *
          (1 + (day.spikeFactor - 1) * config.spikeWeight) *
          shock

      for (let slot = 0; slot < INTERVALS_PER_DAY; slot++) {
        const ts = day.iso + SLOT_TIMES[slot]
        const open = slot >= OPEN_SLOT && slot < CLOSE_SLOT && dailyMean > 0
        if (!open) {
          records.push({ ts, queue: config.name, offered: 0, aht: 0 })
          continue
        }
        const mean = dailyMean * shares[slot - OPEN_SLOT]
        const lambda = gammaSample(rng, normal, config.dispersion, mean / config.dispersion)
        const offered = poissonSample(rng, normal, lambda)
        let aht = 0
        if (offered > 0) {
          const t = slot / 2 + 0.25
          const drift = 1 + 0.03 * ((t - 8) / 12 - 0.5)
          aht = Math.max(120, Math.round(config.ahtBase * drift + normal() * 15))
        }
        records.push({ ts, queue: config.name, offered, aht })
      }
    }
  }

  const outageCount = 6 + Math.floor(rng() * 5)
  let injected = 0
  while (injected < outageCount) {
    const idx = Math.floor(rng() * records.length)
    const record = records[idx]
    if (record.offered >= 20) {
      record.offered = Math.max(1, Math.round(record.offered * 0.1))
      injected++
    }
  }

  return records
}
