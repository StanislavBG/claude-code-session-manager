import type { ReactNode } from 'react'

interface Props {
  title: string
  hint?: ReactNode
}

export function EmptyState({ title, hint }: Props) {
  return (
    <div className="h-full flex items-center justify-center text-fg-faint text-xs">
      <div className="text-center max-w-md">
        <div className="mb-2 text-fg-dim">{title}</div>
        {hint && <div className="text-fg-faint">{hint}</div>}
      </div>
    </div>
  )
}
