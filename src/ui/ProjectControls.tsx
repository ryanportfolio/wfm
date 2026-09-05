import { useRef } from 'react'

interface Props {
  name: string
  onNameChange: (name: string) => void
  canSave: boolean
  onSave: () => void
  onOpen: (file: File) => void
  error: string | null
  status: string | null
}
export function ProjectControls({ name, onNameChange, canSave, onSave, onOpen, error, status }: Props) {
  const input = useRef<HTMLInputElement>(null)
  return <section className="card project-controls" aria-label="Project files">
    <div className="row">
      <label htmlFor="project-name">Project name</label>
      <input id="project-name" className="num-input" maxLength={120} value={name} onChange={e => onNameChange(e.target.value)} />
      <button type="button" className="btn" disabled={!canSave} onClick={onSave}>Save project</button>
      <button type="button" className="btn" onClick={() => input.current?.click()}>Open project</button>
      <input ref={input} type="file" accept=".json,application/json" aria-label="Project JSON file" hidden onChange={e => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) onOpen(file)
      }} />
    </div>
    <p className="note">Save data and planning settings to a JSON file on your device. Opening a project replaces the current work. Files are never uploaded.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
    {status && <p role="status" className="note">{status}</p>}
  </section>
}
