/**
 * Shared destination-path helper for Browser-tab exports (Capture PRD 407,
 * Recorder replay/export PRD 410) — single source of truth for the
 * timestamped filename scheme so both panels write consistently.
 */
export function destPath(prefix: string, mode: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `${prefix}/${ts}-${mode}.${ext}`
}

export function provenanceLine(url: string, mode: string): string {
  return `# Captured from ${url} (${mode}) @ ${new Date().toISOString()}\n`
}
