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

/** Non-method chart colors, also Okabe-Ito (equal is a neutral gray). */
export const EXTRA_COLORS = {
  aht: '#CC79A7',
  staffing: '#0072B2',
  equal: '#8C8C8C',
}

export interface ChartTheme {
  grid: string
  axis: string
  text: string
  actual: string
  tooltipBg: string
  tooltipBorder: string
  /** Matches the CSS --bad token, for marks that flag a miss. */
  bad: string
}

const LIGHT: ChartTheme = {
  grid: '#eae3d5',
  axis: '#6d6759',
  text: '#3f3a55',
  actual: '#565073',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e0d8c7',
  bad: '#b3261e',
}

const DARK: ChartTheme = {
  grid: '#2a2361',
  axis: '#a29cc2',
  text: '#d4cfe8',
  actual: '#aca6cc',
  tooltipBg: '#1b1349',
  tooltipBorder: '#352c72',
  bad: '#ff8f76',
}

/** User theme choice. 'system' follows the OS preference. */
export type ThemePreference = 'light' | 'dark' | 'system'

const THEME_KEY = 'wfm-theme'

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // Storage unavailable (private mode, blocked): fall back to system.
  }
  return 'system'
}

/**
 * Set the data-theme attribute the CSS keys on and persist the choice.
 * 'system' clears both so the prefers-color-scheme media query decides.
 * index.html runs the same attribute logic inline before first paint.
 */
export function applyThemePreference(pref: ThemePreference): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    // Persistence is best-effort; the attribute still applies this session.
  }
}

function isDarkNow(): boolean {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return true
  if (attr === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(isDarkNow)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(isDarkNow())
    mq.addEventListener('change', update)
    // The toggle writes data-theme on <html>; watch it so charts follow.
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', update)
      mo.disconnect()
    }
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
