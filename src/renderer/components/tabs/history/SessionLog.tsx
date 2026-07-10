import { useEffect, useMemo, useRef, useState } from 'react'
import { KVTable, type Column } from '../../ui/KVTable'
import { EmptyState } from '../../ui/EmptyState'
import { useHomeDir } from '../../../lib/useHomeDir'
import { useSessions } from '../../../state/sessions'
import { shellQuote } from '../../../lib/presets'

interface SessionRow {
  sessionId: string
  projectEncoded: string
  path: string
  mtimeMs: number
  sizeBytes: number
}

const PAGE_SIZE = 200

export function SessionLog() {
  const home = useHomeDir()
  const [rows, setRows] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterInput, setFilterInput] = useState('')
  const [logFilter, setLogFilter] = useState('')
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addTab = useSessions((s) => s.addTab)

  const handleFilterChange = (val: string) => {
    setFilterInput(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setLogFilter(val)
      setDisplayLimit(PAGE_SIZE)
    }, 150)
  }

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const { sessions } = await window.api.history.scanProjects()
        if (!cancelled) setRows(sessions)
      } catch (e) {
        console.error('[History] scan failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home])

  const filtered = useMemo(() => {
    if (!logFilter.trim()) return rows
    const q = logFilter.toLowerCase()
    return rows.filter(
      (r) =>
        r.sessionId.toLowerCase().includes(q) ||
        r.projectEncoded.toLowerCase().includes(q)
    )
  }, [rows, logFilter])

  const visibleRows = filtered.slice(0, displayLimit)

  const resume = async (row: SessionRow) => {
    const picked = await window.api.app.pickDirectory()
    if (!picked) return
    addTab({
      cwd: picked,
      startupCommand: `claude --resume ${shellQuote(row.sessionId)}`,
      presetId: 'history-resume',
    })
  }

  const columns: Column<SessionRow>[] = [
    {
      key: 'id',
      header: 'session',
      render: (r) => <span className="font-mono text-fg-dim">{r.sessionId.slice(0, 8)}</span>,
      width: '7rem',
    },
    {
      key: 'proj',
      header: 'project',
      render: (r) => (
        <span className="font-mono text-fg-faint truncate">/{r.projectEncoded.replace(/-/g, '/')}</span>
      ),
    },
    {
      key: 'size',
      header: 'size',
      render: (r) => `${Math.round(r.sizeBytes / 1024)}k`,
      width: '5rem',
    },
    {
      key: 'when',
      header: 'when',
      render: (r) => new Date(r.mtimeMs).toLocaleString(),
      width: '12rem',
    },
    {
      key: 'action',
      header: '',
      render: (r) => (
        <button
          onClick={(e) => {
            e.stopPropagation()
            resume(r)
          }}
          className="px-2 py-0.5 text-xs border border-line rounded text-fg-dim hover:text-fg hover:bg-bg-hi"
        >
          resume
        </button>
      ),
      width: '5rem',
    },
  ]

  const logToolbar = (
    <>
      <input
        value={filterInput}
        onChange={(e) => handleFilterChange(e.target.value)}
        placeholder="filter by id or project"
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint w-64"
      />
      <span className="ml-2 text-fg-faint">
        {filtered.length}/{rows.length}
      </span>
    </>
  )

  return (
    <>
      {logToolbar}
      <div data-testid="history-log" className="h-full overflow-auto">
        {loading ? (
          <EmptyState title="scanning transcripts…" />
        ) : (
          <>
            <KVTable
              columns={columns}
              rows={visibleRows}
              getKey={(r) => r.path}
              empty="no session transcripts found"
            />
            {filtered.length > displayLimit && (
              <div className="p-3 text-center">
                <button
                  onClick={() => setDisplayLimit((n) => n + PAGE_SIZE)}
                  className="text-xs text-fg-faint hover:text-fg"
                >
                  show {Math.min(PAGE_SIZE, filtered.length - displayLimit)} more ({filtered.length - displayLimit} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
