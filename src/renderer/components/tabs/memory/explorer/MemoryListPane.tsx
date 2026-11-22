import { memo } from 'react'
import { formatBytes } from '../../../../lib/formatBytes'
import { ConfigFileCard } from '../../../claudeConfig/ConfigLayout'
import type { ExplorerView, MemoryRow, SortKey } from './model'

export interface ScopeOption { key: string; label: string }

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
  /** MEMORY FOLDER card: file count in this scope and the folder path. */
  folder: { count: number; path: string }
  scopeOptions: ScopeOption[]
  scopeKey: string
  onScopeKey: (key: string) => void
  /** Filter chips — the existing explorer views. */
  view: ExplorerView
  onView: (v: ExplorerView) => void
  counts: { all: number; stale: number; broken: number; recent: number; unindexed: number }
}

const NEXT_SORT: Record<SortKey, SortKey> = { recent: 'name', name: 'size', size: 'recent' }
const SORT_LABEL: Record<SortKey, string> = { recent: 'Recent', name: 'Name', size: 'Size' }

const BADGE = 'text-[9.5px] font-semibold tracking-[.06em] px-[5px] py-px rounded-[3px]'
const CHIP = 'h-7 px-2.5 rounded-full border text-[12.5px] font-medium flex items-center gap-1.5 whitespace-nowrap'

type ChipKey = 'all' | 'stale' | 'broken' | 'recent' | 'unindexed' | 'ask'
const CHIPS: { key: ChipKey; label: string; tone: string }[] = [
  { key: 'all', label: 'All', tone: 'bg-butter/40 text-honey-dark' },
  { key: 'stale', label: 'Stale', tone: 'bg-butter/40 text-honey-dark' },
  { key: 'broken', label: 'Broken', tone: 'bg-accent-muted/30 text-accent-dark' },
  { key: 'recent', label: 'This week', tone: '' },
  { key: 'unindexed', label: 'Unindexed', tone: '' },
  { key: 'ask', label: 'Ask', tone: '' },
]

function chipCount(key: ChipKey, counts: Props['counts']): string {
  if (key === 'ask') return '+'
  const n = counts[key]
  return key === 'unindexed' && n === 0 ? '✓' : String(n)
}

function metaOf(r: MemoryRow): string {
  return `${formatBytes(r.bytes)} · ${r.ageDays > 0 ? `${r.ageDays}d ago` : 'just now'}`
}

export const MemoryListPane = memo(function MemoryListPane(p: Props) {
  return (
    <div data-testid="mx-list" className="flex flex-col min-h-0 bg-bg-elev border-r border-rule-structural">
      <div className="flex flex-col gap-3 px-4 pt-[18px] pb-3">
        <ConfigFileCard
          eyebrow="MEMORY FOLDER"
          badge={<span data-testid="mx-list-folder-count">{`${p.folder.count} files`}</span>}
          path={p.folder.path || '—'}
        >
          <label className="flex items-center gap-2 h-8 px-2.5 rounded-[8px] bg-bg-elev text-[12.5px]">
            <span className="text-fg-faint">Scope</span>
            <select
              data-testid="mx-list-scope"
              aria-label="Memory scope"
              value={p.scopeKey}
              onChange={(e) => p.onScopeKey(e.target.value)}
              className="flex-1 min-w-0 bg-transparent outline-none font-medium text-fg cursor-pointer"
            >
              {p.scopeOptions.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
        </ConfigFileCard>

        <div data-testid="mx-list-chips" className="flex flex-wrap gap-1.5">
          {CHIPS.map((c) => {
            const active = p.view === c.key
            return (
              <button
                key={c.key}
                type="button"
                data-testid={`mx-chip-${c.key}`}
                aria-pressed={active}
                onClick={() => p.onView(c.key)}
                className={`${CHIP} ${c.tone ? `${c.tone} border-transparent` : 'border-rule-structural text-fg'} ${
                  active ? 'ring-1 ring-fg-faint' : ''
                }`}
              >
                <span>{c.label}</span>
                <span className="font-mono text-[11px]">{chipCount(c.key, p.counts)}</span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-serif text-[15px] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{p.title}</span>
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
      <div className="overflow-auto flex-1 px-4 pb-4 flex flex-col gap-0.5">
        {p.rows.map((r) => {
          const sel = p.selected === r.name
          return (
            <div
              key={r.name}
              role="option"
              aria-selected={sel}
              data-testid={`mx-list-row-${r.name}`}
              onClick={() => p.onSelect(r.name)}
              className={`px-3 py-2.5 rounded-xl border cursor-pointer flex flex-col gap-0.5 ${
                sel ? 'bg-bg-hi border-line shadow-sm' : 'border-transparent hover:bg-bg-hi/60'
              }`}
            >
              <div className="flex items-center gap-[7px]">
                <span className={`w-[7px] h-[7px] rounded-[2px] flex-none ${p.clusterDot(r.clusterId)}`} />
                <span
                  className={`text-[13px] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${sel ? 'font-semibold' : 'font-medium'}`}
                >
                  {r.slug}
                </span>
                {r.stale && <span className={`${BADGE} bg-butter/40 text-honey-dark`}>STALE</span>}
                {r.broken && !r.stale && (
                  <span className={`${BADGE} bg-accent-muted/30 text-accent-dark`}>BROKEN</span>
                )}
                {r.notIndexed && <span className={`${BADGE} bg-rule-inner text-fg-dim`}>NOT INDEXED</span>}
              </div>
              <div className="font-mono text-[10.5px] text-fg-dim pl-[14px]">{metaOf(r)}</div>
            </div>
          )
        })}
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
