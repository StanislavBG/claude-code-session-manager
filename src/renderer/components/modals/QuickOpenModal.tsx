import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessions } from '../../state/sessions'
import { toast } from '../../state/toast'
import { log } from '../../lib/logger'
import type { SearchFileEntry } from '../../../preload/api'

/**
 * QuickOpenModal — Cmd+P fuzzy file picker.
 *
 * Lists files from the active tab's cwd (via `window.api.search.files`),
 * applies a renderer-side fuzzy ranker (substring + word-boundary scoring),
 * and on Enter writes the file's path (relative to cwd when possible) as a
 * draft into the active tab's PTY — no submit, so the user can review/edit
 * before pressing Enter in the terminal.
 *
 * Sits on z-[55] (above TabModal's z-50 but below RecordingStatus z-[60]) so
 * a user can keep the privacy banner visible if voice is recording.
 *
 * Keyboard:
 *   ↑ / ↓   move highlight
 *   Enter   open (write path to active PTY)
 *   Esc     close
 *
 * Source-of-inspiration: ClaudeCodeUnleashed's QuickOpen.tsx (which ranks
 * filename matches > path-segment matches > substring > fuzzy character).
 * This port drops lucide-react icons (not a dependency) and the focus-trap
 * hook (single text input + portal — restoring focus on close suffices).
 */

interface QuickOpenModalProps {
  open: boolean
  onClose: () => void
  variant?: 'overlay' | 'page'
}

interface Ranked {
  file: SearchFileEntry
  score: number
  matched: number[]
}

const isWordBoundary = (ch: string) => /[/\\\-_.\s]/.test(ch)
const isUpperCase = (ch: string) => ch >= 'A' && ch <= 'Z'

/**
 * Filename-aware fuzzy match. Mirrors Unleashed's QuickOpen scoring:
 * exact filename > filename-prefix > path-segment exact > substring at
 * word boundary > substring > fuzzy. O(target × query) per file.
 */
function fuzzyMatch(query: string, target: string, fullPath?: string): { match: boolean; score: number; matched: number[] } {
  if (!query) return { match: true, score: 0, matched: [] }
  const queryLower = query.toLowerCase()
  const targetLower = target.toLowerCase()
  const pathLower = (fullPath || target).toLowerCase()

  const fileName = target.split('/').pop() || target
  const fileNameLower = fileName.toLowerCase()

  if (fileNameLower === queryLower) {
    return { match: true, score: 1000, matched: Array.from({ length: fileName.length }, (_, i) => i) }
  }
  if (fileNameLower.startsWith(queryLower)) {
    return { match: true, score: 900, matched: Array.from({ length: query.length }, (_, i) => i) }
  }

  let segScore = 0
  for (const seg of pathLower.split('/')) {
    if (seg === queryLower) return { match: true, score: 800, matched: [] }
    if (seg.startsWith(queryLower)) segScore = Math.max(segScore, 700)
  }

  const subIdx = fileNameLower.indexOf(queryLower)
  if (subIdx !== -1) {
    const atBoundary =
      subIdx === 0 ||
      isWordBoundary(fileNameLower[subIdx - 1]) ||
      isUpperCase(fileName[subIdx])
    return {
      match: true,
      score: atBoundary ? 650 : 600,
      matched: Array.from({ length: query.length }, (_, i) => subIdx + i),
    }
  }

  if (pathLower.includes(queryLower)) {
    return { match: true, score: Math.max(500, segScore), matched: [] }
  }

  let qi = 0
  let score = 0
  let consecutive = 0
  let lastIdx = -1
  let boundaryHits = 0
  const matched: number[] = []
  for (let i = 0; i < targetLower.length && qi < queryLower.length; i++) {
    if (targetLower[i] === queryLower[qi]) {
      matched.push(i)
      score += 10
      if (lastIdx === i - 1) {
        consecutive++
        score += consecutive * 8
      } else {
        consecutive = 0
      }
      const atBoundary = i === 0 || isWordBoundary(targetLower[i - 1]) || isUpperCase(target[i])
      if (atBoundary) {
        boundaryHits++
        score += 15
        if (i === 0) score += 10
      }
      lastIdx = i
      qi++
    }
  }
  if (qi !== queryLower.length) return { match: false, score: 0, matched: [] }
  // Length-bonus and spread-penalty are the same heuristics Unleashed uses.
  const lengthBonus = Math.max(0, 50 - (targetLower.length - queryLower.length))
  score += lengthBonus
  if (boundaryHits >= queryLower.length * 0.5) score += 30
  if (matched.length > 1) {
    const spread = matched[matched.length - 1] - matched[0]
    if (spread > queryLower.length * 3) {
      score -= Math.min(50, (spread - queryLower.length * 3) * 2)
    }
  }
  return { match: true, score: Math.max(1, score), matched }
}

function getRelativePath(full: string, cwd: string): string {
  if (full.startsWith(cwd + '/')) return full.slice(cwd.length + 1)
  if (full === cwd) return ''
  return full
}

function getDirectory(full: string): string {
  const i = full.lastIndexOf('/')
  return i < 0 ? '' : full.slice(0, i)
}

const RECENT_KEY = 'session-manager.quickopen.recent'
const RECENT_MAX = 8

export function QuickOpenModal({ open, onClose, variant = 'overlay' }: QuickOpenModalProps) {
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const cwd = activeTab?.cwd ?? ''

  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<SearchFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Load recent files lazily.
  useEffect(() => {
    if (!open) return
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      if (raw) setRecent(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [open])

  // Reset transient state + focus the input on open.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setHighlight(0)
      return
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  // Load the file list when the modal opens with a valid cwd.
  useEffect(() => {
    if (!open || !cwd) return
    let cancelled = false
    setLoading(true)
    window.api.search
      .files(cwd, '', { limit: 5000 })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          toast.error(`File search failed: ${result.error ?? 'unknown error'}`)
          setFiles([])
          return
        }
        setFiles(result.files)
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        log.error('quick-open', 'search.files threw', { error: msg })
        toast.error(`File search failed: ${msg}`)
        setFiles([])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, cwd])

  // Rank files by query. When no query, show recent first then alphabetical.
  const ranked = useMemo<Ranked[]>(() => {
    if (!query.trim()) {
      const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100)
      return sorted.map((f) => ({ file: f, score: 0, matched: [] }))
    }
    const q = query.trim()
    const scored: Ranked[] = []
    for (const f of files) {
      const r = fuzzyMatch(q, f.name, f.path)
      if (r.match) scored.push({ file: f, score: r.score, matched: r.matched })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 100)
  }, [files, query])

  const recentEntries = useMemo(() => {
    if (query.trim()) return []
    return recent
      .map((p) => files.find((f) => f.path === p) || null)
      .filter((f): f is SearchFileEntry => f !== null)
      .slice(0, 5)
  }, [recent, files, query])

  // Clamp highlight when the list shrinks.
  useEffect(() => {
    const total = recentEntries.length + ranked.length
    if (highlight >= total) setHighlight(Math.max(0, total - 1))
  }, [recentEntries.length, ranked.length, highlight])

  // Scroll selected row into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-row="${highlight}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const handleSelect = useCallback((filePath: string) => {
    // Update recent list.
    try {
      const next = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, RECENT_MAX)
      setRecent(next)
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch { /* ignore */ }
    // Write the file path to the active PTY as a draft (no submit — user
    // can review before pressing Enter). Use the relative path when inside cwd
    // for ergonomics, else the absolute path.
    const tabId = activeTab?.id
    if (!tabId) {
      toast.error('No active tab to receive file path')
      return
    }
    const rel = cwd ? getRelativePath(filePath, cwd) : filePath
    const payload = rel || filePath
    try {
      window.api.pty.write({ tabId, data: payload })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('quick-open', 'pty.write failed', { error: msg })
      toast.error(`Failed to write to terminal: ${msg}`)
      return
    }
    onClose()
  }, [activeTab?.id, cwd, recent, onClose])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const total = recentEntries.length + ranked.length
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (total === 0) return
      setHighlight((h) => Math.min(total - 1, h + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (total === 0) return
      setHighlight((h) => Math.max(0, h - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (highlight < recentEntries.length) {
        const f = recentEntries[highlight]
        if (f) handleSelect(f.path)
        return
      }
      const idx = highlight - recentEntries.length
      const r = ranked[idx]
      if (r) handleSelect(r.file.path)
    }
  }, [highlight, ranked, recentEntries, handleSelect, onClose])

  if (!open) return null

  const renderName = (name: string, matched: number[]) => {
    if (matched.length === 0) return name
    const set = new Set(matched)
    return name.split('').map((ch, i) => (
      <span key={i} className={set.has(i) ? 'text-accent font-semibold' : ''}>{ch}</span>
    ))
  }

  let rowIndex = -1
  const isPage = variant === 'page'

  const node = (
    <div
      className={isPage
        ? 'h-full w-full flex flex-col bg-bg'
        : 'fixed inset-0 z-[55] flex items-start justify-center bg-black/60 pt-[12vh]'}
      onClick={isPage ? undefined : (e) => { if (e.target === e.currentTarget) onClose() }}
      data-testid="quick-open-backdrop"
    >
      <div
        role={isPage ? undefined : 'dialog'}
        aria-modal={isPage ? undefined : 'true'}
        aria-label="Quick Open"
        className={isPage
          ? 'h-full w-full flex flex-col'
          : 'w-[640px] max-w-[90vw] max-h-[70vh] bg-bg-elev border border-line rounded shadow-xl flex flex-col'}
        data-testid="quick-open"
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-line p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0) }}
            placeholder={cwd ? 'Search files in this project…' : 'No active tab — open a terminal first'}
            disabled={!cwd}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent text-fg placeholder:text-fg-dim outline-none px-2 py-1.5 text-sm"
            aria-label="Search files"
          />
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto" role="listbox">
          {loading ? (
            <div className="px-4 py-6 text-sm text-fg-dim">Loading…</div>
          ) : !cwd ? (
            <div className="px-4 py-6 text-sm text-fg-dim">Open a terminal tab to enable Quick Open.</div>
          ) : recentEntries.length === 0 && ranked.length === 0 ? (
            <div className="px-4 py-6 text-sm text-fg-dim">
              {query ? 'No files match.' : 'No files found in this project.'}
            </div>
          ) : (
            <>
              {recentEntries.length > 0 && (
                <div>
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-dim">Recent</div>
                  {recentEntries.map((f) => {
                    rowIndex++
                    const idx = rowIndex
                    const selected = idx === highlight
                    return (
                      <button
                        key={`r:${f.path}`}
                        data-row={idx}
                        role="option"
                        aria-selected={selected}
                        onClick={() => handleSelect(f.path)}
                        onMouseEnter={() => setHighlight(idx)}
                        className={`w-full text-left px-3 py-1.5 text-sm flex flex-col gap-0.5 ${
                          selected ? 'bg-bg-hi text-fg' : 'hover:bg-bg-hi/50 text-fg'
                        }`}
                      >
                        <span className="truncate">{f.name}</span>
                        <span className="text-xs text-fg-dim truncate">{getRelativePath(getDirectory(f.path), cwd)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {ranked.length > 0 && (
                <div>
                  {recentEntries.length > 0 && (
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-dim border-t border-line">Files</div>
                  )}
                  {ranked.map(({ file, matched }) => {
                    rowIndex++
                    const idx = rowIndex
                    const selected = idx === highlight
                    return (
                      <button
                        key={file.path}
                        data-row={idx}
                        role="option"
                        aria-selected={selected}
                        onClick={() => handleSelect(file.path)}
                        onMouseEnter={() => setHighlight(idx)}
                        className={`w-full text-left px-3 py-1.5 text-sm flex flex-col gap-0.5 ${
                          selected ? 'bg-bg-hi text-fg' : 'hover:bg-bg-hi/50 text-fg'
                        }`}
                      >
                        <span className="truncate">{renderName(file.name, matched)}</span>
                        <span className="text-xs text-fg-dim truncate">{getRelativePath(getDirectory(file.path), cwd)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="border-t border-line px-3 py-1.5 flex items-center justify-between text-[10px] text-fg-dim">
          <span>
            <kbd className="px-1 py-0.5 rounded bg-bg-hi border border-line">↑↓</kbd> navigate{' '}
            <kbd className="ml-2 px-1 py-0.5 rounded bg-bg-hi border border-line">↵</kbd> insert into terminal{' '}
            <kbd className="ml-2 px-1 py-0.5 rounded bg-bg-hi border border-line">Esc</kbd> close
          </span>
          <span>{ranked.length + recentEntries.length} {ranked.length + recentEntries.length === 1 ? 'file' : 'files'}</span>
        </div>
      </div>
    </div>
  )

  if (!isPage && typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
