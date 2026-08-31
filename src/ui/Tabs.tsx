export type TabId = 'data' | 'forecast' | 'accuracy' | 'staffing' | 'capacity'

const TABS: { id: TabId; label: string }[] = [
  { id: 'data', label: 'Data' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'staffing', label: 'Staffing' },
  { id: 'capacity', label: 'Capacity' },
]

interface TabsProps {
  active: TabId
  onChange: (tab: TabId) => void
}

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab-btn${active === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
