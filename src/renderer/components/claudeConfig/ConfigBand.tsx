/**
 * ConfigBand — the dark band header of the Claude config page, shared by the
 * Home (`~/.claude`) and Project (cwd) scopes. Palette B: this band is the only
 * dark surface on the page; everything below it is paper.
 *
 * Design: session-manager-operations/design-mocks/claude-config/ (DESIGN_SPEC.md §2,
 * ConfigWorkbench.dc.html band markup). Colors are app tokens only — the band's
 * `#2a221a` is `bg-fg` with `text-bg-hi` (DESIGN_SPEC.md §4 token note).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'
import { Z } from '../../lib/zLayers'
import { searchConfig, type ConfigSearchGroup, type ConfigSearchItem } from '../../lib/configSearch'
import { toast } from '../../state/toast'
import type { McpCheckResult } from '../../../preload/api'

export interface ConfigBandTab<K extends string = string> {
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
 * The band's title column floor in px — the `min-w-[236px]` class on the
 * `config-band-title` group below. Tailwind needs that class literal, so keep
 * the two in step by hand.
 */
export const BAND_TITLE_MIN_W_PX = 236

/**
 * Default `compactScopePath` limit, derived from BAND_TITLE_MIN_W_PX: the path
 * is `font-mono text-xs` (12px IBM Plex Mono, a 0.6em = 7.2px advance), so
 * floor(236 / 7.2) = 32 characters fill the title column's width.
 */
export const SCOPE_PATH_MAX_CHARS = Math.floor(BAND_TITLE_MIN_W_PX / 7.2)

/**
 * Shortens a scope path for the band by eliding from the START, so the last
 * folder — the part that names the scope — always shows. Splits on both `/`
 * and `\` and joins with the path's own separator (a Windows path shortens to
 * `…\` plus its trailing segments). Returns `path` unchanged when it is at
 * most `max` characters; otherwise `…` + separator plus as many trailing
 * segments as fit, and always the last segment whole even if that alone
 * exceeds `max`.
 */
export function compactScopePath(path: string, max = SCOPE_PATH_MAX_CHARS): string {
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

export interface ConfigBandProps<K extends string = string> {
  eyebrow: string
  title: string
  scopePath: string
  tabs: ReadonlyArray<ConfigBandTab<K>>
  activeKey: K
  onSelect: (key: K) => void
  /** Called with the query as the user types in "Search all config" (and with '' on Esc). */
  onSearch?: (query: string) => void
  /** Controls the field's value; omit to let the band own it. */
  searchQuery?: string
  /** Called each time the field gains focus (e.g. to load search items lazily). */
  onSearchFocus?: () => void
  /** Keys pressed in the field other than Esc (which the band handles: clear + blur). */
  onSearchKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** Results panel shown under the field while it has focus and a non-empty query. */
  searchPanel?: ReactNode
  /** The field's element, for callers that blur it after a choice. */
  searchInputRef?: RefObject<HTMLInputElement>
  /** Called when the LEARN link is pressed. */
  onLearn?: () => void
}

// ───────────────────────────────────────────── tab counts (shared by Home and Project)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A checked MCP server that failed or needs sign-in puts the attention dot on the MCP tab. */
export function mcpNeedsAttention(results: Record<string, McpCheckResult>): boolean {
  return Object.values(results).some((r) => r.status === 'failed' || r.status === 'needs-auth')
}

/** The band chip for a CLAUDE.md file count: `missing` (warn) at 0, else `N file(s)`. */
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

export function ConfigBand<K extends string = string>({
  eyebrow,
  title,
  scopePath,
  tabs,
  activeKey,
  onSelect,
  onSearch,
  searchQuery,
  onSearchFocus,
  onSearchKeyDown,
  searchPanel,
  searchInputRef,
  onLearn,
}: ConfigBandProps<K>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const ownInputRef = useRef<HTMLInputElement>(null)
  const inputRef = searchInputRef ?? ownInputRef
  const [ownQuery, setOwnQuery] = useState('')
  const query = searchQuery ?? ownQuery
  const [focused, setFocused] = useState(false)

  const setQuery = (q: string) => {
    if (searchQuery === undefined) setOwnQuery(q)
    onSearch?.(q)
  }

  // '/' jumps to the search field unless the user is already typing somewhere. Capture phase +
  // preventDefault, so a tab's own '/' shortcut (Memory's palette) sees it as handled.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('[contenteditable="true"]'))) return
      if (!inputRef.current) return
      e.preventDefault()
      inputRef.current.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [inputRef])

  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      e.currentTarget.blur()
      return
    }
    onSearchKeyDown?.(e)
  }

  const showPanel = focused && query.trim() !== '' && searchPanel != null

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    onSelect(tabs[next].key)
  }

  return (
    <div
      data-testid="config-band"
      // Design band (ConfigWorkbench.dc.html): 84px tall border-box, 0 28px padding, 236px title column.
      className="shrink-0 box-border h-[84px] bg-fg text-bg-hi border-b border-fg px-7 py-0 flex items-center gap-[26px] whitespace-nowrap"
    >
      {/* Title group never shrinks below its content (BAND_TITLE_MIN_W_PX = 236px floor); the tab strip yields first. */}
      <div data-testid="config-band-title" className="flex flex-col gap-0.5 min-w-[236px] shrink-0">
        <span className="text-[10.5px] font-semibold tracking-[0.1em] text-bg-hi/60">{eyebrow}</span>
        <span className="flex items-baseline gap-2.5">
          <span className="font-serif text-[25px] font-medium leading-[1.15] text-bg-hi">{title}</span>
          <span data-testid="config-band-path" title={scopePath} className="inline-block font-mono text-xs text-rhythm">
            {compactScopePath(scopePath)}
          </span>
        </span>
      </div>

      {/* p-1 / -m-1: the scroller clips at its padding box, so 4px of padding keeps the active
          tab's shadow and its 2px focus ring inside it; the negative margin keeps the layout. */}
      <div role="tablist" aria-label={title} className="flex items-center gap-1.5 min-w-0 overflow-x-auto p-1 -m-1">
        {tabs.map((tab, i) => {
          const active = tab.key === activeKey
          return (
            <button
              key={tab.key}
              ref={(el) => { tabRefs.current[i] = el }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-testid={`config-band-tab-${tab.key}`}
              onClick={() => onSelect(tab.key)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`h-12 flex items-center gap-2.5 pl-[13px] pr-3.5 rounded-xl border border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-butter ${
                active ? 'bg-bg text-fg shadow-sm' : 'text-bg-elev hover:bg-bg/10'
              }`}
            >
              <AlmanacIcon name={tab.icon} size={18} stroke={1.7} className={active ? 'text-fg' : 'text-rhythm'} />
              <span className="text-[14.5px] font-semibold">{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  data-testid="config-band-count"
                  className={`font-mono text-xs px-[7px] py-0.5 rounded-md ${chipClass(active, !!tab.warn)}`}
                >
                  {tab.count}
                </span>
              )}
              {tab.attention && (
                <span
                  data-testid="config-band-attention"
                  aria-label="needs attention"
                  className="w-[7px] h-[7px] rounded-full bg-butter -ml-1"
                />
              )}
            </button>
          )
        })}
      </div>

      <span className="flex-1" />

      <div className="relative">
        <label className="flex items-center gap-2.5 w-[250px] h-10 px-3 rounded-[10px] bg-bg/[0.08] border border-bg/[0.14] text-[13px] text-bg-hi/60 focus-within:border-bg/30">
          <AlmanacIcon name="search" size={15} className="shrink-0" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search all config"
            placeholder="Search all config"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => { setFocused(true); onSearchFocus?.() }}
            onBlur={() => setFocused(false)}
            onKeyDown={onFieldKeyDown}
            className="flex-1 min-w-0 bg-transparent outline-none text-bg-hi placeholder:text-bg-hi/60"
          />
          <kbd className="font-mono text-[11px] px-1.5 py-px rounded border border-bg/20">/</kbd>
        </label>
        {showPanel && (
          <div
            data-testid="config-search-panel"
            // Keep focus in the field while a row is pressed, so the click still lands.
            onMouseDown={(e) => e.preventDefault()}
            className={`absolute right-0 top-full mt-1.5 w-[380px] max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-bg-hi text-fg shadow-lg whitespace-normal ${Z.dialog}`}
          >
            {searchPanel}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onLearn}
        className="text-[11px] font-semibold tracking-[0.08em] text-butter hover:underline"
      >
        LEARN
      </button>
    </div>
  )
}

// ───────────────────────────────────────────── search results

export interface ConfigSearchResultsProps {
  groups: ConfigSearchGroup[]
  /** Items are still loading. */
  loading: boolean
  /** Index into the flattened rows (group order, then row order). */
  activeIndex: number
  /** The band's tabs, for each group's label. */
  tabs: ReadonlyArray<ConfigBandTab>
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
                <span className="text-[13px] font-medium text-fg truncate">{item.title}</span>
                {item.detail && <span className="text-[11.5px] text-fg-dim truncate">{item.detail}</span>}
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
 * the active row, plus the ConfigBand props and ConfigSearchResults props that wire them.
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
