/** Trigger a browser download of `text` as `filename` via a Blob object URL. */
export function downloadTextFile(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Queue names etc. as a safe filename part: "Voice Support" -> "voice-support". */
export function fileSlug(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'data'
}
