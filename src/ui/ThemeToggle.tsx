import { useState } from 'react'
import type { ThemePreference } from './theme'
import { applyThemePreference, readThemePreference } from './theme'

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

/** Header control for the light / dark / system theme choice. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(readThemePreference)

  const choose = (next: ThemePreference) => {
    setPref(next)
    applyThemePreference(next)
  }

  return (
    <div className="seg seg-sm" role="group" aria-label="Color theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={pref === o.value ? 'active' : ''}
          aria-pressed={pref === o.value}
          onClick={() => choose(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
