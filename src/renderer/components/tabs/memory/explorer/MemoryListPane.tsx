import { memo } from 'react'
import { formatBytes } from '../../../../lib/formatBytes'
import type { MemoryRow, SortKey } from './model'

interface Props {
  title: string
  rows: MemoryRow[]
  clusterDot: (clusterId: string | null) => string
  selected: string | null
  onSelect: (name: string) => void
  query: string
  onQuery: (q: string) => void
  sort: SortKey
  onSort: (next: SortKey) => void
  onNew: () => void
  empty: { title: string; body: string; action: string; onAction: () => void } | null
}

const NEXT_SORT: Record<SortKey, SortKey> = { recent: 'name', name: 'size', size: 'recent' }
const SORT_LABEL: Record<SortKey, string> = { recent: 'Recent', name: 'Name', size: 'Size' }

const BADGE = 'text-[9.5px] font-semibold tracking-[.06em] px-[5px] py-px rounded-[3px]'

function metaOf(r: MemoryRow): string {
  return `${formatBytes(r.bytes)} · ${r.ageDays > 0 ? `${r.ageDays}d ago` : 'just now'}`
}

export const MemoryListPane = memo(function MemoryListPane(p: Props) {
  return (
    <div data-testid="mx-list" className="flex flex-col min-h-0 border-r border-rule-structural">
      <div className="flex flex-col gap-[10px] px-[14px] pt-[14px] pb-[10px] border-b border-rule-structural">
        <div className="flex items-center gap-2">
          <span className="font-serif text-lg min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {p.title}
          </span>
          <span className="text-[12px] text-fg-dim">{p.rows.length}</span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="mx-list-new"
            onClick={p.onNew}
            className="text-[12px] font-medium h-[26px] px-[10px] border border-rule-structural rounded-[5px] bg-bg-hi text-fg flex-none hover:border-fg"
          >
            + New
          </button>
        </div>
        <div className="flex gap-[6px] items-center">
          <input
            data-testid="mx-list-filter"
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            placeholder="Filter by name or content…"
            className="flex-1 min-w-0 h-7 border border-rule-structural rounded-[5px] px-[9px] text-[12px] text-fg bg-bg-hi outline-none"
          />
          <button
            type="button"
            data-testid="mx-list-sort"
            onClick={() => p.onSort(NEXT_SORT[p.sort])}
            className="h-7 px-[9px] border border-rule-structural rounded-[5px] flex items-center text-[12px] text-fg whitespace-nowrap hover:border-fg-faint"
          >
            {`${SORT_LABEL[p.sort]} ⇅`}
          </button>
        </div>
      </div>
      <div className="overflow-auto flex-1 p-[6px]">
        {p.rows.map((r) => (
          <div
            key={r.name}
            data-testid={`mx-list-row-${r.name}`}
            onClick={() => p.onSelect(r.name)}
            className={`px-[10px] py-2 rounded-md cursor-pointer flex flex-col gap-[3px] hover:bg-bg-elev ${
              p.selected === r.name ? 'bg-muteband' : ''
            }`}
          >
            <div className="flex items-center gap-[7px]">
              <span className={`w-[7px] h-[7px] rounded-[2px] flex-none ${p.clusterDot(r.clusterId)}`} />
              <span className="text-[13px] font-medium flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {r.slug}
              </span>
              {r.stale && <span className={`${BADGE} bg-butter/40 text-honey-dark`}>STALE</span>}
              {r.broken && !r.stale && (
                <span className={`${BADGE} bg-accent-muted/30 text-accent-dark`}>BROKEN</span>
              )}
              {r.notIndexed && <span className={`${BADGE} bg-rule-inner text-fg-dim`}>NOT INDEXED</span>}
            </div>
            <div className="text-[11.5px] text-fg-dim pl-[14px] overflow-hidden text-ellipsis whitespace-nowrap">
              {r.description}
            </div>
            <div className="font-mono text-[10.5px] text-fg-dim pl-[14px]">{metaOf(r)}</div>
          </div>
        ))}
        {p.empty && p.rows.length === 0 && (
          <div data-testid="mx-list-empty" className="px-[18px] py-10 flex flex-col gap-2 items-start">
            <span className="font-serif text-[17px] text-fg">{p.empty.title}</span>
            <span className="text-[12.5px] leading-normal text-fg-dim">{p.empty.body}</span>
            <button
              type="button"
              onClick={p.empty.onAction}
              className="mt-[6px] text-[12px] font-medium h-7 px-3 border border-rule-structural rounded-[5px] bg-bg-hi text-fg"
            >
              {p.empty.action}
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
