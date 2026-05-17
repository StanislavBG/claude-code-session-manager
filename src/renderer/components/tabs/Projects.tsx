import { useEffect, useRef, useState } from 'react'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { Tooltip } from '../ui/Tooltip'
import { Modal } from '../ui/Modal'
import { useHomeDir } from '../../lib/useHomeDir'
import { useSessions } from '../../state/sessions'
import { shellQuote } from '../../lib/presets'
import { useProjectsPrefs, type SortCol } from '../../state/projectsPrefs'
import { enrichProject, type ProjectDetails } from '../../lib/projectEnrichment'
import { formatBytes } from '../../lib/formatBytes'
import { ClaudeMdDrawer } from './projects/ClaudeMdDrawer'
import type { DirEntry } from '../../../preload/api'

interface ProjectRow {
  encoded: string
  displayPath: string
  sessionCount: number
  lastSession: number
  path: string
  sizeBytes: number
}

interface EnrichmentState extends ProjectDetails {
  cwd: string | null
}

function candidatePath(encoded: string): string {
  return encoded.replace(/-/g, '/')
}

async function resolveProjectCwd(projectFolder: string): Promise<string | null> {
  const files = await window.api.config.listDir(projectFolder, { filesOnly: true })
  const jsonl = (files.entries as DirEntry[])
    .filter((f) => f.name.endsWith('.jsonl'))
    .sort((a, b) => a.size - b.size)
  for (const f of jsonl) {
    const r = await window.api.config.readText(f.path)
    if (!r.exists || !r.text) continue
    for (const line of r.text.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd
      } catch {
        // skip malformed line
      }
    }
  }
  return null
}


function formatRelTime(ms: number): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  const days = diff / 86_400_000
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 7) return `${Math.floor(days)}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(ms).toLocaleDateString()
}

function Shimmer() {
  return <span className="inline-block h-3 w-12 rounded bg-bg-hi animate-pulse" aria-hidden />
}

function Chip({
  label,
  active,
  onClick,
  tip,
}: {
  label: string
  active: boolean
  onClick: () => void
  tip: string
}) {
  return (
    <Tooltip content={tip} align="bottom-center">
      <button
        onClick={onClick}
        title={tip}
        className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
          active
            ? 'border-blue-500 text-blue-400 bg-blue-500/10'
            : 'border-line text-fg-faint hover:text-fg hover:border-fg-faint'
        }`}
      >
        {label}
      </button>
    </Tooltip>
  )
}

function ActionBtn({
  tip,
  onClick,
  disabled,
  danger,
  children,
}: {
  tip: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip content={tip}>
      <button
        onClick={(e) => { e.stopPropagation(); if (!disabled) onClick() }}
        title={tip}
        disabled={disabled}
        className={`px-1.5 py-0.5 rounded text-sm leading-none transition-colors ${
          disabled
            ? 'text-fg-faint/30 cursor-not-allowed'
            : danger
              ? 'text-red-400/60 hover:text-red-400 hover:bg-red-950/30'
              : 'text-fg-faint hover:text-fg hover:bg-bg-hi'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

const MS_7D = 7 * 86_400_000
const MS_30D = 30 * 86_400_000

const EDITOR_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'auto' },
  { value: 'code', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'subl', label: 'Sublime' },
  { value: 'nano', label: 'nano' },
]

export function Projects() {
  const home = useHomeDir()
  const [rows, setRows] = useState<ProjectRow[]>([])
  const [loading, setLoading] = useState(true)
  const [enriched, setEnriched] = useState<Record<string, EnrichmentState>>({})
  const [inputValue, setInputValue] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Drawer: encoded name of the project whose CLAUDE.md is shown
  const [drawerEncoded, setDrawerEncoded] = useState<string | null>(null)
  // Archive confirmation: list of encoded names pending confirmation
  const [archiveConfirm, setArchiveConfirm] = useState<string[] | null>(null)
  const [archiving, setArchiving] = useState(false)
  // Error toast
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Row highlight from stats pill click
  const [highlightEncoded, setHighlightEncoded] = useState<string | null>(null)

  const tableContainerRef = useRef<HTMLDivElement>(null)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  const addTab = useSessions((s) => s.addTab)

  const {
    hydrated,
    hydrate,
    pinned,
    togglePin,
    sort,
    setSort,
    recentFilter,
    setRecentFilter,
    hasRemote,
    setHasRemote,
    hasClaudemd,
    setHasClaudemd,
    pinnedOnly,
    setPinnedOnly,
    setSearch,
    editor,
    setEditor,
  } = useProjectsPrefs()

  // Hydrate prefs on mount
  useEffect(() => {
    hydrate()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync search input from hydrated store (once, on hydration)
  const didSyncSearch = useRef(false)
  useEffect(() => {
    if (hydrated && !didSyncSearch.current) {
      didSyncSearch.current = true
      const stored = useProjectsPrefs.getState().search
      setInputValue(stored)
      setDebouncedSearch(stored)
    }
  }, [hydrated])

  // 200ms debounce: propagate inputValue → debouncedSearch + persist
  useEffect(() => {
    if (!didSyncSearch.current) return
    const t = setTimeout(() => {
      setDebouncedSearch(inputValue)
      setSearch(inputValue)
    }, 200)
    return () => clearTimeout(t)
  }, [inputValue, setSearch])

  // Auto-dismiss error after 3s
  useEffect(() => {
    if (!errorMsg) return
    const t = setTimeout(() => setErrorMsg(null), 3000)
    return () => clearTimeout(t)
  }, [errorMsg])

  // Initial project scan
  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await window.api.config.listDir(`${home}/.claude/projects`, { dirsOnly: true })
        if (cancelled) return
        const next: ProjectRow[] = []
        for (const e of r.entries as DirEntry[]) {
          if (cancelled) return
          const files = await window.api.config.listDir(e.path, { filesOnly: true })
          const jsonl = (files.entries as DirEntry[]).filter((f) => f.name.endsWith('.jsonl'))
          const lastSession = jsonl.reduce((m, f) => Math.max(m, f.mtimeMs), 0)
          const sizeBytes = jsonl.reduce((s, f) => s + f.size, 0)
          next.push({
            encoded: e.name,
            displayPath: candidatePath(e.name),
            sessionCount: jsonl.length,
            lastSession,
            path: e.path,
            sizeBytes,
          })
        }
        next.sort((a, b) => b.lastSession - a.lastSession)
        if (!cancelled) {
          setRows(next)
          setEnriched({})
          setSelected(new Set())
        }
      } catch (err) {
        console.error('[Projects] scan failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [home])

  // Concurrent enrichment
  useEffect(() => {
    if (!rows.length) return
    let cancelled = false
    const queue = rows.slice()
    let inFlight = 0

    const tick = () => {
      while (!cancelled && inFlight < 6 && queue.length) {
        const row = queue.shift()!
        inFlight++
        resolveProjectCwd(row.path)
          .then(async (cwd) => {
            if (cancelled) return
            const details = cwd ? await enrichProject(cwd) : {}
            if (cancelled) return
            setEnriched((prev) => ({ ...prev, [row.encoded]: { cwd: cwd ?? null, ...details } }))
          })
          .catch(() => {
            if (!cancelled) {
              setEnriched((prev) => ({ ...prev, [row.encoded]: { cwd: null } }))
            }
          })
          .finally(() => {
            inFlight--
            if (!cancelled) tick()
          })
      }
    }

    tick()
    return () => { cancelled = true }
  }, [rows])

  // Derived column visibility
  const enrichmentDone = Object.keys(enriched).length >= rows.length
  const hasAnyRemote = Object.values(enriched).some((e) => e.gitRemote)
  const hasAnyBranch = Object.values(enriched).some((e) => e.lastBranch)
  const showGitRemote = rows.length > 0 && (hasAnyRemote || !enrichmentDone)
  const showBranch = rows.length > 0 && (hasAnyBranch || !enrichmentDone)

  // Filter rows
  const now = Date.now()
  const filteredRows = rows.filter((r) => {
    if (recentFilter === '7d' && now - r.lastSession > MS_7D) return false
    if (recentFilter === '30d' && now - r.lastSession > MS_30D) return false
    if (pinnedOnly && !pinned[r.encoded]) return false
    const e = enriched[r.encoded]
    if (e) {
      if (hasRemote === true && !e.gitRemote) return false
      if (hasRemote === false && !!e.gitRemote) return false
      if (hasClaudemd === true && !e.claudemdPreview) return false
      if (hasClaudemd === false && !!e.claudemdPreview) return false
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      const hit =
        r.displayPath.toLowerCase().includes(q) ||
        (e?.cwd?.toLowerCase().includes(q) ?? false) ||
        (e?.name?.toLowerCase().includes(q) ?? false) ||
        (e?.gitRemote?.toLowerCase().includes(q) ?? false) ||
        (e?.claudemdPreview?.toLowerCase().includes(q) ?? false)
      if (!hit) return false
    }
    return true
  })

  // Sort: pinned always first
  const sortedRows = [...filteredRows].sort((a, b) => {
    const pa = pinned[a.encoded] ? 1 : 0
    const pb = pinned[b.encoded] ? 1 : 0
    if (pa !== pb) return pb - pa
    let cmp = 0
    switch (sort.col) {
      case 'project': {
        const na = enriched[a.encoded]?.cwd ?? a.displayPath
        const nb = enriched[b.encoded]?.cwd ?? b.displayPath
        cmp = na.localeCompare(nb)
        break
      }
      case 'sessions':
        cmp = a.sessionCount - b.sessionCount
        break
      case 'last':
        cmp = a.lastSession - b.lastSession
        break
      case 'size':
        cmp = a.sizeBytes - b.sizeBytes
        break
    }
    return sort.dir === 'asc' ? cmp : -cmp
  })

  // Checkbox state for header
  const allVisibleSelected =
    sortedRows.length > 0 && sortedRows.every((r) => selected.has(r.encoded))
  const someSelected = sortedRows.some((r) => selected.has(r.encoded))

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected && !allVisibleSelected
    }
  }, [someSelected, allVisibleSelected])

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        sortedRows.forEach((r) => next.delete(r.encoded))
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        sortedRows.forEach((r) => next.add(r.encoded))
        return next
      })
    }
  }

  // Helpers
  const resolveCwd = async (r: ProjectRow): Promise<string | null> =>
    enriched[r.encoded]?.cwd ?? (await resolveProjectCwd(r.path))

  const showError = (msg: string) => setErrorMsg(msg)

  const openInSession = async (row: ProjectRow) => {
    let cwd = enriched[row.encoded]?.cwd ?? null
    if (!cwd) cwd = await resolveProjectCwd(row.path)
    if (!cwd) {
      cwd = await window.api.app.pickDirectory()
      if (!cwd) return
    }
    const id = crypto.randomUUID()
    addTab({
      id,
      cwd,
      startupCommand: `claude --dangerously-skip-permissions --session-id ${shellQuote(id)}`,
      presetId: 'projects-tab',
    })
  }

  const handleOpenInEditor = async (r: ProjectRow) => {
    const cwd = await resolveCwd(r)
    if (!cwd) { showError('Project directory not yet resolved'); return }
    const result = await window.api.app.openInEditor(cwd, editor || null)
    if (!result.ok) showError(result.error ?? 'No editor found')
  }

  const handleOpenInFinder = async (r: ProjectRow) => {
    const cwd = await resolveCwd(r)
    if (!cwd) { showError('Project directory not yet resolved'); return }
    const result = await window.api.app.openInFinder(cwd)
    if (!result.ok) showError(result.error ?? 'Failed to open file manager')
  }

  const handleOpenInTerminal = async (r: ProjectRow) => {
    const cwd = await resolveCwd(r)
    if (!cwd) { showError('Project directory not yet resolved'); return }
    const result = await window.api.app.openInTerminal(cwd)
    if (!result.ok) showError(result.error ?? 'No terminal emulator found')
  }

  const handleOpenDrawer = (r: ProjectRow) => {
    setDrawerEncoded(r.encoded)
  }

  // Archive helpers
  const runArchive = async (encodeds: string[]) => {
    setArchiveConfirm(null)
    setArchiving(true)
    const archived: string[] = []
    for (const encoded of encodeds) {
      try {
        const result = await window.api.app.archiveProject(encoded)
        if (result.ok) archived.push(encoded)
        else showError(result.error ?? `Failed to archive ${encoded}`)
      } catch (err: unknown) {
        showError(err instanceof Error ? err.message : 'Archive failed')
      }
    }
    if (archived.length) {
      setRows((prev) => prev.filter((r) => !archived.includes(r.encoded)))
      setSelected((prev) => {
        const next = new Set(prev)
        archived.forEach((enc) => next.delete(enc))
        return next
      })
      if (drawerEncoded && archived.includes(drawerEncoded)) setDrawerEncoded(null)
    }
    setArchiving(false)
  }

  // Stats strip data
  const totalProjects = rows.length
  const active7d = rows.filter((r) => now - r.lastSession < MS_7D).length
  const totalSessions = rows.reduce((s, r) => s + r.sessionCount, 0)
  const totalSize = rows.reduce((s, r) => s + r.sizeBytes, 0)
  const top3Active = [...rows]
    .filter((r) => now - r.lastSession < MS_7D)
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, 3)

  const scrollToRow = (encoded: string) => {
    const el = tableContainerRef.current?.querySelector(`[data-row-key="${encoded}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightEncoded(encoded)
    setTimeout(() => setHighlightEncoded(null), 2000)
  }

  const sortHeader = (col: SortCol, label: string) => (
    <Tooltip content={`Sort by ${label}`} align="bottom-center">
      <button
        onClick={() => setSort(col)}
        title={`Sort by ${label}`}
        className="flex items-center gap-1 hover:text-fg w-full uppercase tracking-wider"
      >
        <span>{label}</span>
        {sort.col === col && (
          <span className="text-[10px] leading-none">{sort.dir === 'asc' ? '▲' : '▼'}</span>
        )}
      </button>
    </Tooltip>
  )

  const drawerCwd = drawerEncoded ? (enriched[drawerEncoded]?.cwd ?? null) : null
  const drawerProjectName = drawerEncoded
    ? (enriched[drawerEncoded]?.cwd ?? `/${candidatePath(drawerEncoded)}`)
    : ''

  // Conditional enrichment columns
  const conditionalCols: Column<ProjectRow>[] = []
  if (showBranch) {
    conditionalCols.push({
      key: 'branch',
      header: 'branch',
      width: '8rem',
      render: (r) => {
        const e = enriched[r.encoded]
        if (!e) return <Shimmer />
        return e.lastBranch ? (
          <span className="font-mono text-fg-faint truncate block">{e.lastBranch}</span>
        ) : (
          <span className="text-fg-faint">—</span>
        )
      },
    })
  }
  if (showGitRemote) {
    conditionalCols.push({
      key: 'remote',
      header: 'remote',
      render: (r) => {
        const e = enriched[r.encoded]
        if (!e) return <Shimmer />
        return e.gitRemote ? (
          <span className="font-mono text-fg-faint truncate block text-[10px]">{e.gitRemote}</span>
        ) : (
          <span className="text-fg-faint">—</span>
        )
      },
    })
  }

  const columns: Column<ProjectRow>[] = [
    {
      key: 'select',
      header: (
        <input
          ref={headerCheckboxRef}
          type="checkbox"
          checked={allVisibleSelected}
          onChange={toggleSelectAll}
          className="accent-accent cursor-pointer"
          title="Select all visible"
          onClick={(e) => e.stopPropagation()}
        />
      ),
      width: '2rem',
      className: 'px-1',
      render: (r) => (
        <input
          type="checkbox"
          checked={selected.has(r.encoded)}
          onChange={() => {
            setSelected((prev) => {
              const next = new Set(prev)
              if (next.has(r.encoded)) next.delete(r.encoded)
              else next.add(r.encoded)
              return next
            })
          }}
          onClick={(e) => e.stopPropagation()}
          className="accent-accent cursor-pointer"
        />
      ),
    },
    {
      key: 'pin',
      header: '',
      width: '2rem',
      className: 'px-1',
      render: (r) => (
        <Tooltip content={pinned[r.encoded] ? 'Unpin' : 'Pin to top'}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              togglePin(r.encoded)
            }}
            title={pinned[r.encoded] ? 'Unpin' : 'Pin to top'}
            className={`text-sm leading-none transition-colors ${
              pinned[r.encoded] ? 'text-yellow-400' : 'text-fg-faint hover:text-fg-dim'
            }`}
          >
            {pinned[r.encoded] ? '★' : '☆'}
          </button>
        </Tooltip>
      ),
    },
    {
      key: 'path',
      header: sortHeader('project', 'project'),
      render: (r) => {
        const e = enriched[r.encoded]
        const displayCwd = e?.cwd ?? `/${r.displayPath}`
        const label = (
          <span className="font-mono text-fg-dim truncate block max-w-[22rem]">{displayCwd}</span>
        )
        return e?.claudemdPreview ? (
          <Tooltip
            content={
              <span className="font-mono text-[9px] whitespace-pre-wrap">{e.claudemdPreview}</span>
            }
            align="bottom-center"
          >
            {label}
          </Tooltip>
        ) : (
          label
        )
      },
    },
    {
      key: 'name',
      header: 'name',
      width: '7rem',
      render: (r) => {
        const e = enriched[r.encoded]
        if (!e) return <Shimmer />
        return <span className="text-fg-dim truncate block">{e.name ?? '—'}</span>
      },
    },
    {
      key: 'sessions',
      header: sortHeader('sessions', 'sessions'),
      width: '6rem',
      render: (r) => <span className="text-fg-dim">{r.sessionCount}</span>,
    },
    {
      key: 'size',
      header: sortHeader('size', 'size'),
      width: '6rem',
      render: (r) => <span className="text-fg-faint">{formatBytes(r.sizeBytes)}</span>,
    },
    {
      key: 'last',
      header: sortHeader('last', 'last active'),
      width: '9rem',
      render: (r) => <span className="text-fg-faint">{formatRelTime(r.lastSession)}</span>,
    },
    ...conditionalCols,
    {
      key: 'action',
      header: '',
      width: '11rem',
      render: (r) => {
        const e = enriched[r.encoded]
        const hasClaudeMd = !!e?.claudemdPreview
        return (
          <div className="flex items-center gap-0.5">
            <ActionBtn tip="Open in new terminal session" onClick={() => openInSession(r)}>
              ▷
            </ActionBtn>
            <ActionBtn tip="Open in editor" onClick={() => handleOpenInEditor(r)}>
              ✏
            </ActionBtn>
            <ActionBtn tip="Open in file manager" onClick={() => handleOpenInFinder(r)}>
              ⌂
            </ActionBtn>
            <ActionBtn tip="Open in terminal" onClick={() => handleOpenInTerminal(r)}>
              ⊞
            </ActionBtn>
            <ActionBtn
              tip={hasClaudeMd ? 'Preview CLAUDE.md' : 'No CLAUDE.md'}
              onClick={() => handleOpenDrawer(r)}
              disabled={!hasClaudeMd}
            >
              Ⓜ
            </ActionBtn>
            <ActionBtn
              tip="Archive project"
              onClick={() => setArchiveConfirm([r.encoded])}
              danger
            >
              ⊗
            </ActionBtn>
          </div>
        )
      },
    },
  ]

  return (
    <div className="h-full flex flex-col">
      {/* Stats strip */}
      {!loading && rows.length > 0 && (
        <div className="shrink-0 border-b border-line bg-bg px-3 py-1.5 flex items-center gap-4 text-[10px] text-fg-faint flex-wrap">
          <span><span className="text-fg-dim font-medium">{totalProjects}</span> projects</span>
          <span><span className="text-fg-dim font-medium">{active7d}</span> active 7d</span>
          <span><span className="text-fg-dim font-medium">{totalSessions}</span> sessions</span>
          <span><span className="text-fg-dim font-medium">{formatBytes(totalSize)}</span> on disk</span>
          {top3Active.length > 0 && (
            <span className="flex items-center gap-1 flex-wrap">
              <span className="text-fg-faint">most active:</span>
              {top3Active.map((r) => {
                const label = enriched[r.encoded]?.cwd?.split('/').pop() ?? r.displayPath.split('/').pop() ?? r.encoded
                return (
                  <button
                    key={r.encoded}
                    onClick={() => scrollToRow(r.encoded)}
                    className="px-1.5 py-0 rounded border border-line hover:border-fg-faint hover:text-fg transition-colors font-mono"
                    title={enriched[r.encoded]?.cwd ?? r.displayPath}
                  >
                    {label}
                  </button>
                )
              })}
            </span>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 text-xs">
        <div className="flex flex-col gap-1.5 w-full py-0.5">
          {/* Search + count + editor dropdown row */}
          <div className="flex items-center gap-2">
            <input
              type="search"
              placeholder="search projects…"
              value={inputValue}
              onChange={(ev) => setInputValue(ev.target.value)}
              className="h-6 px-2 bg-bg border border-line rounded text-xs text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint w-48"
            />
            <span className="text-fg-faint">
              {filteredRows.length === rows.length
                ? `${rows.length} projects`
                : `${filteredRows.length} of ${rows.length}`}
            </span>
            <div className="flex-1" />
            <Tooltip content="Preferred editor for 'Open in editor' action">
              <select
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
                className="h-6 bg-bg border border-line rounded text-xs text-fg-dim px-1 focus:outline-none focus:border-fg-faint"
              >
                {EDITOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    Editor: {o.label}
                  </option>
                ))}
              </select>
            </Tooltip>
            <span className="text-fg-faint font-mono truncate">~/.claude/projects/</span>
          </div>
          {/* Filter chips */}
          <div className="flex items-center gap-1 flex-wrap">
            <Chip label="All" active={recentFilter === 'all'} onClick={() => setRecentFilter('all')} tip="Show all projects" />
            <Chip label="≤7d" active={recentFilter === '7d'} onClick={() => setRecentFilter('7d')} tip="Active in last 7 days" />
            <Chip label="≤30d" active={recentFilter === '30d'} onClick={() => setRecentFilter('30d')} tip="Active in last 30 days" />
            <span className="w-px h-3 bg-line mx-0.5 shrink-0" />
            <Chip label="Has remote" active={hasRemote === true} onClick={() => setHasRemote(hasRemote === true ? null : true)} tip="Only projects with a git remote" />
            <Chip label="No remote" active={hasRemote === false} onClick={() => setHasRemote(hasRemote === false ? null : false)} tip="Only projects without a git remote" />
            <span className="w-px h-3 bg-line mx-0.5 shrink-0" />
            <Chip label="Has CLAUDE.md" active={hasClaudemd === true} onClick={() => setHasClaudemd(hasClaudemd === true ? null : true)} tip="Only projects with a CLAUDE.md" />
            <Chip label="No CLAUDE.md" active={hasClaudemd === false} onClick={() => setHasClaudemd(hasClaudemd === false ? null : false)} tip="Only projects without a CLAUDE.md" />
            <span className="w-px h-3 bg-line mx-0.5 shrink-0" />
            <Chip label="Pinned" active={pinnedOnly} onClick={() => setPinnedOnly(!pinnedOnly)} tip="Only pinned projects" />
          </div>
        </div>
      </div>

      {/* Main area: table + optional drawer */}
      <div className="flex-1 min-h-0 flex relative">
        <div className="flex-1 min-w-0 overflow-auto" ref={tableContainerRef}>
          {loading ? (
            <EmptyState title="scanning projects…" />
          ) : (
            <KVTable
              columns={columns}
              rows={sortedRows}
              getKey={(r) => r.encoded}
              activeKey={highlightEncoded}
              empty="no projects with claude session history"
            />
          )}
        </div>
        {drawerEncoded && drawerCwd && (
          <ClaudeMdDrawer
            cwd={drawerCwd}
            projectName={drawerProjectName}
            onClose={() => setDrawerEncoded(null)}
          />
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="shrink-0 border-t border-line bg-bg-elev px-3 py-2 flex items-center gap-2 text-xs">
          <span className="text-fg-faint">{selected.size} selected</span>
          <div className="flex-1" />
          {archiving && (
            <span className="text-fg-faint animate-pulse">archiving…</span>
          )}
          <button
            onClick={() => setArchiveConfirm(Array.from(selected))}
            disabled={archiving}
            className="px-2 py-1 border border-red-900/50 text-red-400/80 rounded hover:bg-red-950/30 hover:text-red-400 disabled:opacity-40 transition-colors"
          >
            Archive {selected.size}
          </button>
          <button
            onClick={async () => {
              const toProcess = rows.filter((r) => selected.has(r.encoded))
              for (const r of toProcess) {
                await handleOpenInEditor(r)
              }
            }}
            disabled={archiving}
            className="px-2 py-1 border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi disabled:opacity-40 transition-colors"
          >
            Open all in editor
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="px-2 py-1 border border-line rounded text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Archive confirmation modal */}
      <Modal
        open={!!archiveConfirm}
        onClose={() => setArchiveConfirm(null)}
        title="Archive projects?"
      >
        <p className="text-sm text-fg-dim mb-1">
          Move {archiveConfirm?.length ?? 0} project{(archiveConfirm?.length ?? 0) !== 1 ? 's' : ''} to
        </p>
        <p className="text-xs text-fg-faint font-mono mb-4">~/.claude/projects-archive/</p>
        {archiveConfirm && archiveConfirm.length <= 5 && (
          <ul className="mb-4 space-y-0.5 text-[10px] font-mono text-fg-faint">
            {archiveConfirm.map((enc) => (
              <li key={enc} className="truncate">{enriched[enc]?.cwd ?? `/${candidatePath(enc)}`}</li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => setArchiveConfirm(null)}
            className="px-3 py-1.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
          >
            Cancel
          </button>
          <button
            onClick={() => archiveConfirm && runArchive(archiveConfirm)}
            className="px-3 py-1.5 text-xs border border-red-900/50 rounded text-red-400 hover:bg-red-950/30"
          >
            Archive
          </button>
        </div>
      </Modal>

      {/* Error toast */}
      {errorMsg && (
        <div
          role="alert"
          className="pointer-events-none fixed bottom-4 right-4 z-50 bg-red-950 border border-red-900/60 text-red-300 text-xs px-3 py-1.5 rounded shadow-lg max-w-xs"
        >
          {errorMsg}
        </div>
      )}

    </div>
  )
}
