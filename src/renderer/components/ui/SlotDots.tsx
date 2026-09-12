interface Props {
  total: number
  inUse: number
  size: 'sm' | 'md'
}

/**
 * SlotDots — the single dot-row renderer for the machine-wide claude -p slot
 * pool, shared by SessionManagerConfig's Session pool card and AlmanacFooter's
 * active-sessions indicator so the two surfaces can't drift apart.
 */
export function SlotDots({ total, inUse, size }: Props) {
  const filled = Math.min(Math.max(inUse, 0), total)
  const dotClass = size === 'md' ? 'w-3.5 h-3.5 rounded-full border' : 'w-2 h-2 rounded-full border'
  return (
    <>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          data-testid="slot-dot"
          data-filled={i < filled ? 'true' : 'false'}
          className={`${dotClass} ${i < filled ? 'bg-accent border-accent' : 'bg-bg border-line'}`}
        />
      ))}
    </>
  )
}
