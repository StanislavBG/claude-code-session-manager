/** StatusDot — shared status indicator dot.
 *  Colors mirror AgentView.tsx StatusChip (offline=grey, working=amber,
 *  default=emerald). `attention` uses the warm accent; `paused` uses zinc.
 *
 *  Back-compat: accepts a legacy `kind` prop (`on|off|warn|live|idle`) so
 *  earlier stub callsites (e.g. InstrumentTile) keep compiling.
 */

export type StatusDotState = 'live' | 'idle' | 'offline' | 'attention' | 'paused'
export type StatusDotKind = 'on' | 'off' | 'warn' | 'live' | 'idle'

type Size = 'sm' | 'md'

type StatusDotProps = {
  state?: StatusDotState
  /** legacy alias for state; mapped to state if provided */
  kind?: StatusDotKind
  pulse?: boolean
  size?: Size
  className?: string
  title?: string
  /** Optional explicit accessible name. Falls back to `title` or the resolved state. */
  'aria-label'?: string
}

const STATE_BG: Record<StatusDotState, string> = {
  live: 'bg-emerald-400',
  idle: 'bg-amber-400',
  offline: 'bg-fg-faint',
  attention: 'bg-accent',
  paused: 'bg-zinc-500',
}

const SIZE_CLASS: Record<Size, string> = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
}

const KIND_TO_STATE: Record<StatusDotKind, StatusDotState> = {
  on: 'live',
  off: 'offline',
  warn: 'attention',
  live: 'live',
  idle: 'idle',
}

export function StatusDot({
  state,
  kind,
  pulse = false,
  size = 'sm',
  className = '',
  title,
  'aria-label': ariaLabel,
}: StatusDotProps) {
  const resolved: StatusDotState = state ?? (kind ? KIND_TO_STATE[kind] : 'idle')
  const colorClass = STATE_BG[resolved]
  const sizeClass = SIZE_CLASS[size]
  const pulseClass = pulse ? 'animate-pulse' : ''
  // Derived a11y label: explicit aria-label > title > the resolved state name.
  const label = ariaLabel ?? title ?? resolved
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block rounded-full ${sizeClass} ${colorClass} ${pulseClass} ${className}`.trim()}
      title={title}
    />
  )
}
