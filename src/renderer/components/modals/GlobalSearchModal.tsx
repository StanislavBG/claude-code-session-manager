import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessions } from '../../state/sessions'
import { toast } from '../../state/toast'
import { log } from '../../lib/logger'
import type { SearchTextMatch } from '../../../preload/api'

/**
 * GlobalSearchModal — Cmd+Shift+F project-wide content search.
 *
 * Hits `window.api.search.text` (ripgrep when available, fs-walk fallback)
 * scoped to the active tab's cwd. Renders file:line:matched-text rows
 * grouped by file. Enter / click writes the absolute path into the active
 * tab's PTY so the user can `@`-mention it inside Claude.
 *
 * Sits on z-[55] above TabModal but below RecordingStatus (z-[60]).
 *
 * Search is debounced 250 ms so the user can type without thrashing rg.
 */

interface GlobalSearchModalProps {
  open: boolean
  onClose: () => void
  variant?: 'overlay' | 'page'
}

interface FileGroup {
  path: string
  matches: SearchTextMatch[]
}

function getRelativePath(full: string, cwd: string): string {
  if (full.startsWith(cwd + '/')) return full.slice(cwd.length + 1)
  if (full === cwd) return ''
  return full
}

function highlightMatch(line: string, query: string, caseSensitive: boolean) {
  // Highlight the FIRST occurrence of the query in the line. ripgrep already
  // returns line-scoped matches; multi-highlight isn't worth the JSX churn.
  if (!query) return line
  const hay = caseSensitive ? line : line.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const idx = hay.indexOf(needle)
  if (idx < 0) return line
  return (
    <>
      {line.slice(0, idx)}
      <span className="text-accent font-semibold">{line.slice(idx, idx + query.length)}</span>
      {line.slice(idx + query.length)}
    </>
  )
}

export function GlobalSearchModal({ open, onClose, variant = 'overlay' }: GlobalSearchModalProps) {
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const cwd = activeTab?.cwd ?? ''

  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matches, setMatches] = useState<SearchTextMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [usedRipgrep, setUsedRipgrep] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // Token guards against stale responses — each search bumps the token, only
  // the latest response is applied.
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setMatches([])
      setError(null)
      setHighlight(0)
      return
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  // Debounced search.
  useEffect(() => {
    if (!open || !cwd) return
    const q = query.trim()
    if (!q) {
      setMatches([])
      setError(null)
      setLoading(false)
      return
    }
    const token = ++tokenRef.current
    setLoading(true)
    const handle = setTimeout(() => {
      window.api.search
        .text(cwd, q, { caseSensitive, limit: 500 })
        .then((result) => {
          if (token !== tokenRef.current) return
          if (!result.ok) {
            setError(result.error ?? 'unknown error')
            setMatches([])
          } else {
            setMatches(result.matches)
            setError(null)
          }
          setUsedRipgrep(result.usedRipgrep)
        })
        .catch((e: unknown) => {
          if (token !== tokenRef.current) return
          const msg = e instanceof Error ? e.message : String(e)
          log.error('global-search', 'search.text threw', { error: msg }, { cwd, tabId: activeTab?.id })
          setError(msg)
          setMatches([])
        })
        .finally(() => { if (token === tokenRef.current) setLoading(false) })
    }, 250)
    return () => clearTimeout(handle)
  }, [open, cwd, query, caseSensitive])

  const groups = useMemo<FileGroup[]>(() => {
    const byPath = new Map<string, SearchTextMatch[]>()
    for (const m of matches) {
      const arr = byPath.get(m.path)
      if (arr) arr.push(m)
      else byPath.set(m.path, [m])
    }
    const out: FileGroup[] = []
    for (const [p, list] of byPath) out.push({ path: p, matches: list })
    // Sort by group size desc, then by path asc — bigger files surface first.
    out.sort((a, b) => b.matches.length - a.matches.length || a.path.localeCompare(b.path))
    return out
  }, [matches])

  const flat = useMemo(() => matches, [matches])

  useEffect(() => {
    if (highlight >= flat.length) setHighlight(Math.max(0, flat.length - 1))
  }, [flat.length, highlight])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-match="${highlight}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const handleSelect = useCallback((m: SearchTextMatch) => {
    const tabId = activeTab?.id
    if (!tabId) {
      toast.error('No active tab to receive path')
      return
    }
    const rel = cwd ? getRelativePath(m.path, cwd) : m.path
    const data = `${rel || m.path}:${m.line}`
    try {
      window.api.pty.write({ tabId, data })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('global-search', 'pty.write failed', { error: msg }, { cwd, tabId })
      toast.error(`Failed to write to terminal: ${msg}`)
      return
    }
    onClose()
  }, [activeTab?.id, cwd, onClose])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flat.length === 0) return
      setHighlight((h) => Math.min(flat.length - 1, h + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length === 0) return
      setHighlight((h) => Math.max(0, h - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const m = flat[highlight]
      if (m) handleSelect(m)
    }
  }, [flat, highlight, handleSelect, onClose])

  if (!open) return null
  const isPage = variant === 'page'

  // Flat index counter shared across groups so arrow keys traverse linearly.
  let matchIdx = -1

  const node = (
    <div
      className={isPage
        ? 'h-full w-full flex flex-col bg-bg'
        : 'fixed inset-0 z-[55] flex items-start justify-center bg-black/60 pt-[8vh]'}
      onClick={isPage ? undefined : (e) => { if (e.target === e.currentTarget) onClose() }}
      data-testid="global-search-backdrop"
    >
      <div
        role={isPage ? undefined : 'dialog'}
        aria-modal={isPage ? undefined : 'true'}
        aria-label="Search in project"
        className={isPage
          ? 'h-full w-full flex flex-col'
          : 'w-[840px] max-w-[95vw] h-[80vh] bg-bg-elev border border-line rounded shadow-xl flex flex-col'}
        data-testid="global-search"
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-line p-2 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0) }}
            placeholder={cwd ? 'Search in this project…' : 'No active tab — open a terminal first'}
            disabled={!cwd}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-fg placeholder:text-fg-dim outline-none px-2 py-1.5 text-sm"
            aria-label="Search query"
          />
          <button
            type="button"
            onClick={() => setCaseSensitive((v) => !v)}
            className={`px-2 py-1 text-xs rounded border ${
              caseSensitive ? 'bg-accent/20 border-accent text-accent' : 'bg-bg border-line text-fg-dim hover:text-fg'
            }`}
            title="Match case"
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto" role="listbox">
          {!cwd ? (
            <div className="px-4 py-6 text-sm text-fg-dim">Open a terminal tab to enable project search.</div>
          ) : !query.trim() ? (
            <div className="px-4 py-6 text-sm text-fg-dim">Type to search files in <span className="font-mono">{cwd}</span>.</div>
          ) : loading ? (
            <div className="px-4 py-6 text-sm text-fg-dim">Searching…</div>
          ) : error ? (
            <div className="px-4 py-6 text-sm text-red-400">{error}</div>
          ) : flat.length === 0 ? (
            <div className="px-4 py-6 text-sm text-fg-dim">No matches for {JSON.stringify(query)}.</div>
          ) : (
            <div>
              {groups.map((g) => (
                <div key={g.path}>
                  <div className="sticky top-0 bg-bg-elev border-b border-line px-3 py-1 text-xs text-fg-dim font-mono truncate">
                    {getRelativePath(g.path, cwd)} <span className="text-fg-faint">({g.matches.length})</span>
                  </div>
                  {g.matches.map((m) => {
                    matchIdx++
                    const idx = matchIdx
                    const selected = idx === highlight
                    return (
                      <button
                        key={`${m.path}:${m.line}:${m.column}:${idx}`}
                        data-match={idx}
                        role="option"
                        aria-selected={selected}
                        onClick={() => handleSelect(m)}
                        onMouseEnter={() => setHighlight(idx)}
                        className={`w-full text-left px-3 py-1 text-xs font-mono flex gap-3 ${
                          selected ? 'bg-bg-hi text-fg' : 'hover:bg-bg-hi/50 text-fg'
                        }`}
                      >
                        <span className="text-fg-dim shrink-0 w-12 text-right">{m.line}</span>
                        <span className="truncate">{highlightMatch(m.text, query, caseSensitive)}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-line px-3 py-1.5 flex items-center justify-between text-[10px] text-fg-dim">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-bg-hi border border-line">↑↓</kbd> navigate{' '}
            <kbd className="ml-2 px-1 py-0.5 rounded bg-bg-hi border border-line">↵</kbd> insert path{' '}
            <kbd className="ml-2 px-1 py-0.5 rounded bg-bg-hi border border-line">Esc</kbd> close
          </span>
          <span>
            {flat.length} {flat.length === 1 ? 'match' : 'matches'}
            {usedRipgrep === false && ' · fs walk (rg missing)'}
          </span>
        </div>
      </div>
    </div>
  )

  if (!isPage && typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
