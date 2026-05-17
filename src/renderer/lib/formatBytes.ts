/**
 * Human-readable byte size. Memory.tsx and Projects.tsx had near-duplicate
 * implementations (one used " K"/" M", the other "KB"/"MB"). Unified on the
 * SI-style suffixes since that's what most file-system tools display.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
