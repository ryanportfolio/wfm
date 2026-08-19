interface EmptyStateProps {
  title: string
  text: string
  onGoData: () => void
}

export function EmptyState({ title, text, onGoData }: EmptyStateProps) {
  return (
    <div className="card empty">
      <h2>{title}</h2>
      <div>{text}</div>
      <button type="button" className="btn btn-primary" onClick={onGoData}>
        Go to the Data tab
      </button>
    </div>
  )
}
