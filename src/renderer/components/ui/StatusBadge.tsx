/**
 * StatusBadge — semantic status pill for scheduler job states.
 *
 * Colors are chosen for WCAG AA compliance (≥4.5:1 contrast ratio) on the
 * app's dark background. "-950/50" backgrounds are very dark; "-200" text
 * is light enough to achieve the required ratio.
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_review'

const CLASSES: Record<JobStatus, string> = {
  pending:      'bg-bg-hi text-fg-dim border-line',
  running:      'bg-amber-950/50 text-amber-200 border-amber-800/60',
  completed:    'bg-green-950/50 text-green-200 border-green-800/60',
  failed:       'bg-red-950/50 text-red-200 border-red-800/60',
  needs_review: 'bg-orange-950/50 text-orange-200 border-orange-800/60',
}

interface StatusBadgeProps {
  status: JobStatus
  className?: string
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border ${CLASSES[status]} ${className}`}
      role="status"
      aria-label={`Status: ${status.replace('_', ' ')}`}
    >
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
      )}
      {status === 'failed' && (
        <span aria-hidden="true">✗</span>
      )}
      {status === 'completed' && (
        <span aria-hidden="true">✓</span>
      )}
      {status.replace('_', ' ')}
    </span>
  )
}
