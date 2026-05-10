import type { ReactNode } from 'react'

interface Props {
  toolbar?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

/**
 * Standard panel shell used by every non-terminal tab. Consists of an optional
 * toolbar row, a scrollable body, and an optional footer (usually a SaveBar).
 */
export function Panel({ toolbar, footer, children }: Props) {
  return (
    <div className="h-full flex flex-col">
      {toolbar && (
        <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-2 text-xs">
          {toolbar}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      {footer && <div className="shrink-0 border-t border-line bg-bg-elev">{footer}</div>}
    </div>
  )
}
