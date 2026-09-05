import { useRef } from 'react'

export type TabId = 'data' | 'forecast' | 'accuracy' | 'staffing' | 'capacity' | 'intraday'

const TABS: { id: TabId; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'staffing', label: 'Staffing' },
  { id: 'capacity', label: 'Capacity' },
  { id: 'intraday', label: 'Intraday' },
]

/**
 * Roving-tabindex target for a tablist keydown: ArrowLeft/ArrowRight wrap,
 * Home/End jump to the edges. Returns null for keys the tablist ignores.
 */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

interface TabsProps {
  active: TabId
  onChange: (tab: TabId) => void
}

export function Tabs({ active, onChange }: TabsProps) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (e: React.KeyboardEvent, current: number) => {
    const next = nextTabIndex(current, e.key, TABS.length)
    if (next === null) return
    e.preventDefault()
    onChange(TABS[next].id)
    btnRefs.current[next]?.focus()
  }

  return (
    // div, not nav: ARIA does not allow the tablist role on a landmark element.
    <div className="tabs" role="tablist" aria-label="Workbench sections" data-tour="tabs">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            btnRefs.current[i] = el
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          className={`tab-btn${active === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
