/**
 * Mirrors src/main/docEdit.cjs's truncateDocumentText — same head+tail+marker
 * scheme. Duplicated (not imported) because main is CommonJS and this is
 * renderer ESM/TS with no shared-module boundary between them. Applied
 * client-side so a huge document buffer never leaves the renderer over IPC
 * and never trips ipcSchemas.cjs's `docEditRun.documentText` length cap —
 * keep both copies' MAX_DOC_CONTEXT/head/tail sizes in sync if either changes.
 */

export const MAX_DOC_CONTEXT = 60000

export function truncateDocumentText(documentText: string): string {
  if (documentText.length <= MAX_DOC_CONTEXT) return documentText
  const head = documentText.slice(0, 40000)
  const tail = documentText.slice(-20000)
  return `${head}\n\n[...document truncated for length...]\n\n${tail}`
}
