import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * Okabe-Ito colorblind-safe palette. The method-to-color mapping is fixed
 * across every tab so a method always reads the same everywhere.
 */
export const METHOD_COLORS = {
  sma: '#56B4E9',
  hw: '#E69F00',
  dhr: '#009E73',
  ensemble: '#D55E00',
} as const

export type UiMethod = keyof typeof METHOD_COLORS

export const METHOD_LABELS: Record<UiMethod, string> = {
  sma: 'Seasonal moving average',
  hw: 'Holt-Winters',
  dhr: 'Dynamic harmonic regression',
  ensemble: 'Ensemble',
}

export const METHOD_SHORT: Record<UiMethod, string> = {
  sma: 'SMA',
  hw: 'Holt-Winters',
  dhr: 'DHR',
  ensemble: 'Ensemble',
}

export const UI_METHODS: UiMethod[] = ['sma', 'hw', 'dhr', 'ensemble']

/** Non-method chart colors, also Okabe-Ito. */
export const EXTRA_COLORS = {
  aht: '#CC79A7',
  staffing: '#0072B2',
}

export interface ChartTheme {
  grid: string
  axis: string
  text: string
  actual: string
  tooltipBg: string
  tooltipBorder: string
}

const LIGHT: ChartTheme = {
  grid: '#e5e8ee',
  axis: '#6b7280',
  text: '#374151',
  actual: '#4b5563',
  tooltipBg: '#ffffff',
  tooltipBorder: '#d8dce3',
}

const DARK: ChartTheme = {
  grid: '#2c3440',
  axis: '#8b94a3',
  text: '#c7cdd8',
  actual: '#a3adbd',
  tooltipBg: '#1c2129',
  tooltipBorder: '#333b47',
}

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function useChartTheme(): ChartTheme {
  return useDarkMode() ? DARK : LIGHT
}

export function tooltipStyle(theme: ChartTheme): CSSProperties {
  return {
    background: theme.tooltipBg,
    border: `1px solid ${theme.tooltipBorder}`,
    borderRadius: 8,
    color: theme.text,
    fontSize: 12,
    boxShadow: 'none',
  }
}
