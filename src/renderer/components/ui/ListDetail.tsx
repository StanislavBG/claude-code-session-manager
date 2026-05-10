import type { ReactNode } from 'react'

interface Props {
  sidebar: ReactNode
  detail: ReactNode
  sidebarWidth?: string
}

/** Two-pane split: fixed-width scrollable sidebar + flexible detail body. */
export function ListDetail({ sidebar, detail, sidebarWidth = '18rem' }: Props) {
  return (
    <div className="h-full flex">
      <div
        className="shrink-0 border-r border-line overflow-y-auto"
        style={{ width: sidebarWidth }}
      >
        {sidebar}
      </div>
      <div className="flex-1 min-w-0 overflow-auto">{detail}</div>
    </div>
  )
}
