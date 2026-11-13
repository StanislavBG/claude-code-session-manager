/**
 * The MD network explorer's Docs view: a table of every census doc, so a human
 * can study hundreds of docs a graph cannot show. Filters by role, searches by
 * path, sorts by recency / size / links / code use, shows staleness flags,
 * summarises the record collections, and offers optional curation badges and
 * folder controls. Curation is persisted by the parent via callbacks.
 */
import { useMemo, useState } from 'react'
import type { MdCensus, MdDoc } from '../../../../../preload/api'
import { docFlags, relativeAge, type MdVerdict } from '../../../../lib/mdCurate'

export type MdDocFilter = 'all' | 'map' | 'scoped' | 'agent' | 'doc' | 'record' | 'unlinked'
export type MdDocSort = 'newest' | 'oldest' | 'lines' | 'linkedFrom' | 'codeRefs'

export const MD_DOC_TABLE_CAP = 500

const FILTERS: readonly { key: MdDocFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'map', label: 'Map' },
  { key: 'scoped', label: 'Scoped' },
  { key: 'agent', label: 'Agent' },
  { key: 'doc', label: 'Doc' },
  { key: 'record', label: 'Record' },
  { key: 'unlinked', label: 'Unlinked' },
]

const SORTS: readonly { key: MdDocSort; label: string }[] = [
  { key: 'newest', label: 'Newest change' },
  { key: 'oldest', label: 'Oldest change' },
  { key: 'lines', label: 'Most lines' },
  { key: 'linkedFrom', label: 'Most linked-from' },
  { key: 'codeRefs', label: 'Most code refs' },
]

const VERDICT_CLASS: Record<MdVerdict, string> = {
  keep: 'bg-sage-dark text-bg-hi',
  update: 'bg-honey text-fg',
  merge: 'bg-fg text-bg-hi',
  delete: 'bg-accent text-bg-hi',
}

function matchesFilter(d: MdDoc, filter: MdDocFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'unlinked') return d.role === 'doc' && d.depth == null
  return d.role === filter
}

export function filterDocs(docs: readonly MdDoc[], filter: MdDocFilter, query: string): MdDoc[] {
  const q = query.trim().toLowerCase()
  return docs.filter((d) => matchesFilter(d, filter) && (!q || d.path.toLowerCase().includes(q)))
}

function byPath(a: MdDoc, b: MdDoc): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** Nulls last regardless of direction; ties fall back to path order. */
function cmpNullable(a: number | null, b: number | null, desc: boolean): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return desc ? b - a : a - b
}

export function sortDocs(docs: readonly MdDoc[], sort: MdDocSort): MdDoc[] {
  const key = (d: MdDoc): number | null => {
    switch (sort) {
      case 'newest':
      case 'oldest':
        return d.lastCommitMs
      case 'lines':
        return d.lines
      case 'linkedFrom':
        return d.linkedFrom
      default:
        return d.codeRefs
    }
  }
  const desc = sort !== 'oldest'
  return [...docs].sort((a, b) => cmpNullable(key(a), key(b), desc) || byPath(a, b))
}

export interface MdDocTableProps {
  census: MdCensus
  selectedPath: string | null
  onSelect: (path: string) => void
  nowMs?: number
  verdicts?: Record<string, MdVerdict>
  reviewedAt?: Record<string, number>
  recordFolders?: string[]
  docFolders?: string[]
  onFolderKind?: (folder: string, kind: 'records' | 'docs' | null) => void
}

const TOGGLE_ON = 'border-accent bg-bg-hi text-fg'
const TOGGLE_OFF = 'border-rule-structural text-fg-dim hover:border-fg-faint'

export function MdDocTable({
  census,
  selectedPath,
  onSelect,
  nowMs,
  verdicts,
  reviewedAt,
  recordFolders,
  docFolders,
  onFolderKind,
}: MdDocTableProps) {
  const [filter, setFilter] = useState<MdDocFilter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MdDocSort>('newest')
  const now = nowMs ?? Date.now()

  const counts = useMemo(() => {
    const c = {} as Record<MdDocFilter, number>
    for (const f of FILTERS) c[f.key] = 0
    for (const d of census.docs) {
      for (const f of FILTERS) if (matchesFilter(d, f.key)) c[f.key]++
    }
    return c
  }, [census.docs])
  const filtered = useMemo(() => filterDocs(census.docs, filter, query), [census.docs, filter, query])
  const sorted = useMemo(() => sortDocs(filtered, sort), [filtered, sort])
  const shown = useMemo(() => sorted.slice(0, MD_DOC_TABLE_CAP), [sorted])

  return (
    <div data-testid="md-doc-table" className="flex min-h-0 flex-col gap-3">
      {census.collections.length > 0 && (
        <div className="flex flex-none flex-col gap-1.5">
          <span className="font-mono text-[11px] text-fg-faint">Record collections</span>
          <div className="flex flex-wrap gap-2">
            {census.collections.map((c) => {
              const isRecords = recordFolders?.includes(c.folder) ?? false
              const isDocs = docFolders?.includes(c.folder) ?? false
              return (
                <div
                  key={c.folder}
                  data-testid="md-doc-table-collection"
                  data-folder={c.folder}
                  className="flex flex-col gap-1 rounded-[9px] border border-rule-structural bg-bg-hi px-3 py-2"
                >
                  <span className="truncate font-mono text-[12px] font-semibold text-fg">{c.folder}</span>
                  <span className="font-mono text-[11px] text-fg-faint">
                    {`${c.docs} docs · ${c.linked} linked · ${relativeAge(c.lastCommitMs, now)}`}
                  </span>
                  {onFolderKind && (
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        data-testid="md-doc-table-folder-records"
                        aria-pressed={isRecords}
                        onClick={() => onFolderKind(c.folder, isRecords ? null : 'records')}
                        className={`rounded-[7px] border px-2 py-0.5 text-[11px] cursor-pointer ${isRecords ? TOGGLE_ON : TOGGLE_OFF}`}
                      >
                        Treat as records
                      </button>
                      <button
                        type="button"
                        data-testid="md-doc-table-folder-docs"
                        aria-pressed={isDocs}
                        onClick={() => onFolderKind(c.folder, isDocs ? null : 'docs')}
                        className={`rounded-[7px] border px-2 py-0.5 text-[11px] cursor-pointer ${isDocs ? TOGGLE_ON : TOGGLE_OFF}`}
                      >
                        Count as docs
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-none flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid="md-doc-table-filter"
            data-filter={f.key}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-[9px] border px-2.5 py-1 text-[12px] cursor-pointer ${filter === f.key ? TOGGLE_ON : TOGGLE_OFF}`}
          >
            {f.label} <span className="font-mono text-[11px] text-fg-faint">{counts[f.key]}</span>
          </button>
        ))}
        <input
          type="search"
          data-testid="md-doc-table-search"
          placeholder="Search paths"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-[30px] min-w-[160px] flex-1 rounded-[9px] border border-rule-structural bg-bg-hi px-2.5 font-mono text-[12px] text-fg"
        />
        <select
          data-testid="md-doc-table-sort"
          aria-label="Sort docs"
          value={sort}
          onChange={(e) => setSort(e.target.value as MdDocSort)}
          className="h-[30px] rounded-[9px] border border-rule-structural bg-bg-hi px-2 text-[12px] text-fg"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {sorted.length > MD_DOC_TABLE_CAP && (
        <span data-testid="md-doc-table-cap" className="font-mono text-[11px] text-fg-faint">
          {`Showing ${MD_DOC_TABLE_CAP} of ${sorted.length} — narrow the filter`}
        </span>
      )}

      <div role="listbox" aria-label="Docs" className="flex min-h-0 flex-col gap-1 overflow-auto">
        {shown.map((d) => {
          const selected = d.path === selectedPath
          const verdict = verdicts?.[d.path]
          const flags = docFlags(d, reviewedAt?.[d.path] ?? null, now)
          return (
            <div
              key={d.path}
              role="option"
              tabIndex={0}
              data-testid="md-doc-table-row"
              data-path={d.path}
              aria-selected={selected ? 'true' : 'false'}
              onClick={() => onSelect(d.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(d.path)
                }
              }}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[9px] border px-3 py-2 cursor-pointer ${
                selected ? 'border-accent bg-bg-hi' : 'border-rule-structural hover:border-fg-faint'
              }`}
            >
              <span className="min-w-0 flex-[1_1_240px] truncate font-mono text-[12px] text-fg">{d.path}</span>
              <span className="font-mono text-[11px] text-fg-faint">{d.role}</span>
              <span className="font-mono text-[11px] text-fg-faint">{relativeAge(d.lastCommitMs, now)}</span>
              <span className="font-mono text-[11px] text-fg-faint" title="lines">{d.lines == null ? '—' : `${d.lines} lines`}</span>
              <span className="font-mono text-[11px] text-fg-faint" title="linked from">{`← ${d.linkedFrom}`}</span>
              <span className="font-mono text-[11px] text-fg-faint" title="code refs">{`code ${d.codeRefs}`}</span>
              {flags.map((f) => (
                <span
                  key={f.flag}
                  data-testid="md-doc-table-flag"
                  data-flag={f.flag}
                  className="rounded-[7px] bg-bg-elev px-1.5 py-0.5 text-[11px] text-fg-dim"
                >
                  {f.label}
                </span>
              ))}
              {verdict && (
                <span
                  data-testid="md-doc-table-verdict"
                  data-verdict={verdict}
                  className={`rounded-[7px] px-1.5 py-0.5 text-[11px] font-semibold ${VERDICT_CLASS[verdict]}`}
                >
                  {verdict}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
