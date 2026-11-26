/**
 * configShared — helpers shared by the Home (`~/.claude`) and Project Claude config pages and
 * their ClaudeConfigShell rail: the tab spec type, tab-count helpers, the scope-path compactor,
 * and the "Search all config" hook + results list.
 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type { AlmanacIconName } from '../layout/AlmanacIcon'
import { searchConfig, type ConfigSearchGroup, type ConfigSearchItem } from '../../lib/configSearch'
import { toast } from '../../state/toast'
import type { McpCheckResult } from '../../../preload/api'

export interface ConfigTabSpec<K extends string = string> {
  key: K
  label: string
  icon: AlmanacIconName
  /** Mono chip after the label — a number or short text such as `3 files` / `missing`. */
  count?: number | string
  /** Renders the status dot (e.g. an MCP server needs attention). */
  attention?: boolean
  /** Tints the count chip as a warning (e.g. CLAUDE.md `missing`). */
  warn?: boolean
}

/**
 * Shortens a scope path for the rail by eliding from the START, so the last
 * folder — the part that names the scope — always shows. Splits on both `/`
 * and `\` and joins with the path's own separator (a Windows path shortens to
 * `…\` plus its trailing segments). Returns `path` unchanged when it is at
 * most `max` characters; otherwise `…` + separator plus as many trailing
 * segments as fit, and always the last segment whole even if that alone
 * exceeds `max`.
 */
export function compactScopePath(path: string, max: number): string {
  if (path.length <= max) return path
  const segments = path.split(/[\\/]/).filter((s) => s !== '')
  if (segments.length === 0) return path
  // The path's own separator: backslash when it has one and no forward slash before it.
  const slash = path.indexOf('/')
  const back = path.indexOf('\\')
  const sep = back !== -1 && (slash === -1 || back < slash) ? '\\' : '/'
  let tail = segments[segments.length - 1]
  for (let i = segments.length - 2; i >= 0; i--) {
    const next = `${segments[i]}${sep}${tail}`
    if (2 + next.length > max) break
    tail = next
  }
  return `…${sep}${tail}`
}

// ───────────────────────────────────────────── tab counts (shared by Home and Project)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A checked MCP server that failed or needs sign-in puts the attention dot on the MCP tab. */
export function mcpNeedsAttention(results: Record<string, McpCheckResult>): boolean {
  return Object.values(results).some((r) => r.status === 'failed' || r.status === 'needs-auth')
}

/** The rail chip for a CLAUDE.md file count: `missing` (warn) at 0, else `N file(s)`. */
export function claudeMdChip(n: number | null): { count?: string; warn?: boolean } {
  if (n == null) return {}
  if (n === 0) return { count: 'missing', warn: true }
  return { count: `${n} ${n === 1 ? 'file' : 'files'}` }
}

/** The file itself plus every @-import that resolves to a file on disk; 0 when the file is absent. */
export async function countClaudeMdFiles(path: string): Promise<number> {
  if (!(await window.api.config.exists(path))) return 0
  const res = await window.api.config.parseImports(path)
  if (!res.ok) throw new Error(res.error)
  return 1 + res.imports.filter((i) => i.exists).length
}

/** How many top-level keys a settings file sets (0 when it is absent or empty). */
export async function countSettingsKeys(path: string): Promise<number> {
  const r = await window.api.config.readJson(path)
  if (r.error) throw new Error(r.error)
  return isRecord(r.data) ? Object.keys(r.data).length : 0
}

export function chipClass(active: boolean, warn: boolean): string {
  if (warn) return active ? 'bg-accent/15 text-accent-dark' : 'bg-accent-muted/15 text-accent-muted'
  return active ? 'bg-fg text-bg-hi' : 'bg-bg/10 text-line'
}

// ───────────────────────────────────────────── search results

export interface ConfigSearchResultsProps {
  groups: ConfigSearchGroup[]
  /** Items are still loading. */
  loading: boolean
  /** Index into the flattened rows (group order, then row order). */
  activeIndex: number
  /** The rail's tabs, for each group's label. */
  tabs: ReadonlyArray<ConfigTabSpec>
  onChoose: (item: ConfigSearchItem) => void
  onHover: (index: number) => void
}

/** "Search all config" results: one section per tab (label + total), its best rows below. */
export function ConfigSearchResults({ groups, loading, activeIndex, tabs, onChoose, onHover }: ConfigSearchResultsProps) {
  if (loading) return <div className="px-3.5 py-3 text-[12.5px] text-fg-dim">Loading…</div>
  if (groups.length === 0) return <div className="px-3.5 py-3 text-[12.5px] text-fg-dim">No matches</div>
  let index = 0
  return (
    <div role="listbox" aria-label="Config search results" className="py-1.5">
      {groups.map((g) => (
        <div key={g.tab} className="py-1">
          <div
            data-testid="config-search-group"
            className="flex items-center justify-between px-3.5 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-[0.08em] uppercase text-fg-dim"
          >
            <span>{tabs.find((t) => t.key === g.tab)?.label ?? g.tab}</span>
            <span className="font-mono">{g.total}</span>
          </div>
          {g.items.map((item) => {
            const i = index++
            const active = i === activeIndex
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onChoose(item)}
                onMouseEnter={() => onHover(i)}
                className={`w-full text-left px-3.5 py-1.5 flex items-baseline gap-2 min-w-0 ${active ? 'bg-bg-elev' : ''}`}
              >
                <span className="text-[13px] font-medium text-fg shrink-0">{item.title}</span>
                {item.detail && <span className="text-[11.5px] text-fg-dim min-w-0 truncate">{item.detail}</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export interface UseConfigSearchInput {
  /** Reads every searchable item; called on the field's first focus per `loadKey`. */
  load: () => Promise<ConfigSearchItem[]>
  /** Identity of what `load` reads (e.g. the cwd); a change drops loaded items. */
  loadKey: string
  onChoose: (item: ConfigSearchItem) => void
}

/**
 * The state behind "Search all config": lazy-loaded items, the query, grouped results and
 * the active row, plus the rail props and ConfigSearchResults props that wire them.
 */
export function useConfigSearch({ load, loadKey, onChoose }: UseConfigSearchInput) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; items: ConfigSearchItem[] } | null>(null)
  const requested = useRef<string | null>(null)

  const items = loaded && loaded.key === loadKey ? loaded.items : null
  const groups = useMemo(() => (items ? searchConfig(items, query) : []), [items, query])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  const onSearchFocus = useCallback(() => {
    if (requested.current === loadKey) return
    requested.current = loadKey
    load().then(
      (list) => setLoaded({ key: loadKey, items: list }),
      (err: unknown) => {
        toast.error(`Search all config: ${err instanceof Error ? err.message : String(err)}`)
        setLoaded({ key: loadKey, items: [] })
      },
    )
  }, [load, loadKey])

  const onSearch = useCallback((q: string) => {
    setQuery(q)
    setActiveIndex(0)
  }, [])

  const choose = useCallback(
    (item: ConfigSearchItem) => {
      onChoose(item)
      setQuery('')
      setActiveIndex(0)
      inputRef.current?.blur()
    },
    [onChoose],
  )

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (flat.length === 0) return
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((i) => (i + step + flat.length) % flat.length)
      } else if (e.key === 'Enter') {
        const item = flat[Math.min(activeIndex, flat.length - 1)]
        if (!item) return
        e.preventDefault()
        choose(item)
      }
    },
    [flat, activeIndex, choose],
  )

  return {
    bandProps: { searchQuery: query, onSearch, onSearchFocus, onSearchKeyDown, searchInputRef: inputRef },
    panelProps: { groups, loading: items === null, activeIndex, onChoose: choose, onHover: setActiveIndex },
  }
}
