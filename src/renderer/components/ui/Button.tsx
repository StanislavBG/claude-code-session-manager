import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

/**
 * Small text-button primitive used by toolbars and footers across the app.
 * Four near-duplicates lived in SchedulerPrdsView (TBtn), Memory, SchedulePanel,
 * and elsewhere — unified here.
 *
 * Three variants:
 *   - default (border-line, hover bg-bg-hi)
 *   - primary (border-accent, accent text)
 *   - danger  (border-red, red text)
 *
 * Pass `tooltip` to wrap in Tooltip + add a native title fallback. Children
 * are the visible label; size is fixed-small (text-xs px-2 py-0.5) to match
 * existing surfaces — don't grow this without a separate primitive.
 */
export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  tooltip,
  type = 'button',
  className: extraClass,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'default' | 'primary' | 'danger'
  tooltip?: string
  type?: 'button' | 'submit'
  className?: string
}) {
  const variantClass =
    variant === 'primary'
      ? 'text-accent border-accent/50 hover:bg-bg-hi'
      : variant === 'danger'
        ? 'text-red-400 hover:text-red-300 border-line hover:border-red-400/50'
        : 'text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
  const cls = `px-2 py-0.5 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${variantClass} ${extraClass ?? ''}`
  const btn = (
    <button
      type={type}
      title={tooltip}
      onClick={onClick}
      disabled={disabled}
      className={cls}
    >
      {children}
    </button>
  )
  return tooltip ? <Tooltip content={tooltip} align="bottom-center">{btn}</Tooltip> : btn
}
