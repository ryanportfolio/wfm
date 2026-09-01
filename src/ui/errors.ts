/** Human-readable message from a caught value of unknown type. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || 'unknown error'
  const s = String(err)
  return s === '' || s === '[object Object]' ? 'unknown error' : s
}
