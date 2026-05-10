import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
  className?: string
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  getKey: (row: T) => string
  onRowClick?: (row: T) => void
  activeKey?: string | null
  empty?: ReactNode
}

/**
 * Lightweight tabular list for directory listings, hook events, server lists etc.
 * Monospaced, compact rows, optional click handler for drilldown.
 */
export function KVTable<T>({ columns, rows, getKey, onRowClick, activeKey, empty }: Props<T>) {
  if (rows.length === 0) {
    return (
      <div className="p-6 text-fg-faint text-xs text-center">{empty ?? 'no entries'}</div>
    )
  }
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-bg-elev text-fg-faint uppercase tracking-wider">
        <tr className="border-b border-line">
          {columns.map((c) => (
            <th
              key={c.key}
              className={`text-left font-normal px-3 py-1.5 ${c.className ?? ''}`}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const k = getKey(row)
          const active = activeKey === k
          return (
            <tr
              key={k}
              data-row-key={k}
              onClick={() => onRowClick?.(row)}
              className={`border-b border-line/50 transition-colors ${
                onRowClick ? 'cursor-pointer' : ''
              } ${active ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:bg-bg-hi/50'}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-1 ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
