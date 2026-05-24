import { useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { KVTable, type Column } from '../ui/KVTable'
import { EmptyState } from '../ui/EmptyState'
import { useHomeDir } from '../../lib/useHomeDir'
import { useSessions } from '../../state/sessions'
import { shellQuote } from '../../lib/presets'
import { HistoryDashboard } from './HistoryDashboard'
import type { DirEntry } from '../../../preload/api'

interface SessionRow {
  sessionId: string
  projectEncoded: string
  path: string
  mtimeMs: number
  sizeBytes: number
}

type View = 'dashboard' | 'log'

// Local-TZ ISO dates — must match the aggregator's bucket TZ (see
// historyAggregator.cjs's `localDate`), otherwise the upper bound mis-aligns
// for users west of UTC and today's data disappears.
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA')
}

function thirtyDaysAgoLocal(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toLocaleDateString('en-CA')
}

export function History() {
  const home = useHomeDir()
  const [rows, setRows] = useState<SessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [logFilter, setLogFilter] = useState('')
  const addTab = useSessions((s) => s.addTab)

  const [view, setView] = useState<View>(() =>
    (localStorage.getItem('sm.historyTab.view') as View) ?? 'dashboard'
  )
  const [fromDate, setFromDate] = useState(thirtyDaysAgoLocal)
  const [toDate, setToDate] = useState(todayLocal)
  const [projectFilter, setProjectFilter] = useState('')

  const switchView = (v: View) => {
    setView(v)
    localStorage.setItem('sm.historyTab.view', v)
  }

  useEffect(() => {
    if (!home) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const projects = await window.api.config.listDir(`${home}/.claude/projects`, {
          dirsOnly: true,
        })
        const all: SessionRow[] = []
        for (const proj of projects.entries as DirEntry[]) {
          if (cancelled) return
          const files = await window.api.config.listDir(proj.path, { filesOnly: true })
          for (const f of files.entries as DirEntry[]) {
            if (!f.name.endsWith('.jsonl')) continue
            all.push({
              sessionId: f.name.replace(/\.jsonl$/, ''),
              projectEncoded: proj.name,
              path: f.path,
              mtimeMs: f.mtimeMs,
              sizeBytes: f.size,
            })
          }
        }
        all.sort((a, b) => b.mtimeMs - a.mtimeMs)
        if (!cancelled) setRows(all)
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

  const viewToggle = (
    <div className="flex items-center border border-line rounded overflow-hidden text-xs">
      <button
        onClick={() => switchView('dashboard')}
        className={`px-3 py-1 ${view === 'dashboard' ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
      >
        Dashboard
      </button>
      <button
        onClick={() => switchView('log')}
        className={`px-3 py-1 border-l border-line ${view === 'log' ? 'bg-bg-hi text-fg' : 'text-fg-faint hover:text-fg'}`}
      >
        Log
      </button>
    </div>
  )

  const dashToolbar = (
    <>
      <input
        type="date"
        value={fromDate}
        onChange={(e) => setFromDate(e.target.value)}
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
      />
      <span className="text-fg-faint">–</span>
      <input
        type="date"
        value={toDate}
        onChange={(e) => setToDate(e.target.value)}
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
      />
      <input
        value={projectFilter}
        onChange={(e) => setProjectFilter(e.target.value)}
        placeholder="filter by project"
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint w-48"
      />
      <div className="flex-1" />
      {viewToggle}
    </>
  )

  const logToolbar = (
    <>
      <input
        value={logFilter}
        onChange={(e) => setLogFilter(e.target.value)}
        placeholder="filter by id or project"
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint w-64"
      />
      <span className="ml-2 text-fg-faint">
        {filtered.length}/{rows.length}
      </span>
      <div className="flex-1" />
      {viewToggle}
    </>
  )

  return (
    <Panel toolbar={view === 'dashboard' ? dashToolbar : logToolbar}>
      {view === 'dashboard' ? (
        <HistoryDashboard
          fromDate={fromDate}
          toDate={toDate}
          projectFilter={projectFilter}
          onProjectClick={(cwd) => setProjectFilter(cwd)}
        />
      ) : (
        <div data-testid="history-log" className="h-full">
          {loading ? (
            <EmptyState title="scanning transcripts…" />
          ) : (
            <KVTable
              columns={columns}
              rows={filtered}
              getKey={(r) => r.path}
              empty="no session transcripts found"
            />
          )}
        </div>
      )}
    </Panel>
  )
}
