import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  PrdListItem,
  ScheduleJob,
  ScheduleStateSnapshot,
} from '../../../preload/api.d'

/**
 * BackgroundAgentsModal — port of Unleashed's BackgroundAgentsPanel onto our
 * existing scheduler IPC. The scheduler runs PRDs from
 * ~/.claude/session-manager/scheduled-plans/prds/ as `claude -p` jobs; this
 * modal is just an Unleashed-style queue UI for them.
 *
 * Mapping:
 *  - "Task" = scheduler PRD (one .md file)
 *  - "Priority" (high/normal/low) = parallelGroup buckets (10/50/90)
 *  - "Start/Pause queue" = firePolicy toggle between 'when-available' and 'manual'
 *  - "Max concurrent" = config.concurrencyCap
 *  - "Retry" = schedule.resetJob(slug)
 *  - "Add task" = schedule.writePrd(slug, body) with synthetic frontmatter
 *  - "Output" = schedule.readLog(runId, slug)
 *  - "Clear completed" = renderer-side hidden set (localStorage)
 *  - "Remove task" = renderer-side hide + open folder to let user delete the .md
 *
 * State is owned by the main process; we subscribe to schedule:state.
 *
 * Complexity: O(N) per render where N = jobs.length. N is bounded by PRDs on
 *   disk (single-digit to low double-digit in practice), so no batching needed.
 */

const HIDDEN_KEY = 'sm.backgroundAgents.hiddenSlugs'

type Priority = 'high' | 'normal' | 'low'

const PRIORITY_TO_GROUP: Record<Priority, number> = { high: 10, normal: 50, low: 90 }

function groupToPriority(group: number): Priority {
  if (group <= 20) return 'high'
  if (group <= 70) return 'normal'
  return 'low'
}

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x: unknown) => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveHidden(set: Set<string>) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])) } catch { /* */ }
}

function formatDuration(start: string | null, end: string | null, nowMs: number): string {
  if (!start) return '–'
  const startMs = Date.parse(start)
  if (Number.isNaN(startMs)) return '–'
  const endMs = end ? Date.parse(end) : nowMs
  const sec = Math.max(0, Math.floor((endMs - startMs) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

/** Slugify a free-form task name. Mirrors `SLUG_RE` in scheduler.cjs:
 *  /^[A-Za-z0-9._-]{1,128}$/. We prefix with NN (parallelGroup) to honor
 *  the filename-as-group convention. */
function makeSlug(name: string, group: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task'
  const ts = Date.now().toString(36)
  const slug = `${String(group).padStart(2, '0')}-${base}-${ts}`
  return slug.slice(0, 128)
}

function buildPrdBody(opts: { title: string; cwd: string; prompt: string }): string {
  // Minimal frontmatter mirroring src/main/scheduler.cjs's parsePrd().
  const fm = [
    '---',
    `title: "${opts.title.replace(/"/g, '\\"')}"`,
    `cwd: "${opts.cwd}"`,
    '---',
    '',
  ].join('\n')
  return fm + opts.prompt.trim() + '\n'
}

interface Props {
  variant?: 'overlay' | 'page'
  open: boolean
  onClose: () => void
}

interface RowState {
  expanded: boolean
  logText: string | null
  loadingLog: boolean
}

export function BackgroundAgentsModal({ open, onClose, variant = 'overlay' }: Props) {
  const [snap, setSnap] = useState<ScheduleStateSnapshot | null>(null)
  const [prdList, setPrdList] = useState<PrdListItem[]>([])
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden())
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrompt, setNewPrompt] = useState('')
  const [newPriority, setNewPriority] = useState<Priority>('normal')
  const [now, setNow] = useState(() => Date.now())
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Subscribe to scheduler state.
  useEffect(() => {
    if (!open) return
    let off: (() => void) | null = null
    window.api.schedule.state().then(setSnap).catch(() => {})
    window.api.schedule.listPrds().then(setPrdList).catch(() => {})
    off = window.api.schedule.onState((s) => {
      setSnap(s)
      window.api.schedule.listPrds().then(setPrdList).catch(() => {})
    })
    return () => { if (off) off() }
  }, [open])

  // 1s tick for live duration display.
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])

  // ESC to close.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Derived: visible jobs sorted by status priority then group.
  const visibleJobs = useMemo<ScheduleJob[]>(() => {
    if (!snap) return []
    const statusRank: Record<ScheduleJob['status'], number> = {
      running: 0, pending: 1, failed: 2, needs_review: 2, completed: 3,
    }
    return snap.jobs
      .filter((j) => !hidden.has(j.slug))
      .slice()
      .sort((a, b) => {
        const sa = statusRank[a.status] ?? 9
        const sb = statusRank[b.status] ?? 9
        if (sa !== sb) return sa - sb
        if (a.parallelGroup !== b.parallelGroup) return a.parallelGroup - b.parallelGroup
        return a.slug.localeCompare(b.slug)
      })
  }, [snap, hidden])

  const counts = useMemo(() => {
    const c = { pending: 0, running: 0, completed: 0, failed: 0 }
    if (!snap) return c
    for (const j of snap.jobs) {
      if (j.status in c) c[j.status as keyof typeof c]++
    }
    return c
  }, [snap])

  const isQueueRunning = snap?.config.firePolicy !== 'manual' && !snap?.paused

  const toggleExpanded = useCallback(async (job: ScheduleJob) => {
    const existing = rows[job.slug]
    const expanded = !existing?.expanded
    setRows((r) => ({
      ...r,
      [job.slug]: { expanded, logText: existing?.logText ?? null, loadingLog: false },
    }))
    if (!expanded) return
    // Lazy-load the log on first expand (or whenever the job has a runId we
    // haven't fetched yet).
    if (job.runId && !existing?.logText) {
      setRows((r) => ({
        ...r,
        [job.slug]: { expanded: true, logText: null, loadingLog: true },
      }))
      try {
        const res = await window.api.schedule.readLog(job.runId, job.slug)
        setRows((r) => ({
          ...r,
          [job.slug]: {
            expanded: true,
            logText: res.ok ? (res.text ?? '') : (res.error ? `(log unavailable: ${res.error})` : '(no log yet)'),
            loadingLog: false,
          },
        }))
      } catch (e) {
        setRows((r) => ({
          ...r,
          [job.slug]: {
            expanded: true,
            logText: `(log fetch failed: ${e instanceof Error ? e.message : String(e)})`,
            loadingLog: false,
          },
        }))
      }
    } else if (!job.runId) {
      // No run yet — show the PRD body preview as "output".
      setRows((r) => ({
        ...r,
        [job.slug]: { expanded: true, logText: job.bodyPreview, loadingLog: false },
      }))
    }
  }, [rows])

  // Refresh log of any expanded running job on snap change.
  useEffect(() => {
    if (!snap) return
    for (const job of snap.jobs) {
      const row = rows[job.slug]
      if (!row?.expanded) continue
      if (job.status !== 'running') continue
      if (!job.runId) continue
      window.api.schedule.readLog(job.runId, job.slug).then((res) => {
        setRows((r) => {
          // Only update if still expanded.
          if (!r[job.slug]?.expanded) return r
          return {
            ...r,
            [job.slug]: {
              expanded: true,
              logText: res.ok ? (res.text ?? '') : (r[job.slug]?.logText ?? ''),
              loadingLog: false,
            },
          }
        })
      }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  const handleStartQueue = useCallback(async () => {
    setBusy(true)
    try {
      // Switch policy to when-available + clear any pause + kick a run.
      await window.api.schedule.setConfig({ firePolicy: 'when-available' })
      await window.api.schedule.resume()
      await window.api.schedule.runNow()
    } finally {
      setBusy(false)
    }
  }, [])

  const handlePauseQueue = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.schedule.setConfig({ firePolicy: 'manual' })
    } finally {
      setBusy(false)
    }
  }, [])

  const handleSetMaxConcurrent = useCallback(async (n: number) => {
    await window.api.schedule.setConfig({ concurrencyCap: Math.max(1, Math.min(5, n)) })
  }, [])

  const handleClearCompleted = useCallback(() => {
    if (!snap) return
    setHidden((prev) => {
      const next = new Set(prev)
      for (const j of snap.jobs) {
        if (j.status === 'completed' || j.status === 'failed') next.add(j.slug)
      }
      saveHidden(next)
      return next
    })
  }, [snap])

  const handleRemoveTask = useCallback((slug: string) => {
    // We don't delete the .md from disk (no API for it); we hide it from view
    // and the user can open the folder to delete if they want.
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(slug)
      saveHidden(next)
      return next
    })
  }, [])

  const handleRetry = useCallback(async (slug: string) => {
    await window.api.schedule.resetJob(slug)
    await window.api.schedule.runNow()
  }, [])

  const handleSetPriority = useCallback(async (job: ScheduleJob, priority: Priority) => {
    if (job.status === 'running') return // can't re-group a running job
    const targetGroup = PRIORITY_TO_GROUP[priority]
    if (job.parallelGroup === targetGroup) return
    // To change parallelGroup we have to rewrite the PRD's filename. We don't
    // have a rename IPC, so we rewrite the body keeping the same slug and
    // override parallelGroup via frontmatter — parsePrd() honors the FM value
    // over the filename prefix.
    const cur = await window.api.schedule.readPrd(job.slug)
    if (!cur.ok || !cur.text) return
    const text = cur.text
    let body: string
    if (text.startsWith('---\n')) {
      const end = text.indexOf('\n---', 4)
      if (end !== -1) {
        const fmRaw = text.slice(4, end)
        const tail = text.slice(end + 4).replace(/^\n/, '')
        const lines = fmRaw.split('\n').filter((l) => !/^parallelGroup\s*:/.test(l))
        lines.push(`parallelGroup: ${targetGroup}`)
        body = `---\n${lines.join('\n')}\n---\n${tail}`
      } else {
        body = `---\nparallelGroup: ${targetGroup}\n---\n${text}`
      }
    } else {
      body = `---\nparallelGroup: ${targetGroup}\n---\n${text}`
    }
    await window.api.schedule.writePrd(job.slug, body)
  }, [])

  const handleOpenFolder = useCallback(async () => {
    await window.api.schedule.openFolder()
  }, [])

  const handleAdd = useCallback(async () => {
    setAddError(null)
    const name = newName.trim()
    const prompt = newPrompt.trim()
    if (!name || !prompt) {
      setAddError('Name and prompt are required.')
      return
    }
    const cwd = snap?.config.defaultCwd
    if (!cwd) {
      setAddError('No default cwd configured in scheduler.')
      return
    }
    const group = PRIORITY_TO_GROUP[newPriority]
    const slug = makeSlug(name, group)
    setBusy(true)
    try {
      const body = buildPrdBody({ title: name, cwd, prompt })
      const res = await window.api.schedule.writePrd(slug, body)
      if (!res.ok) {
        setAddError('Failed to write PRD.')
        return
      }
      setNewName('')
      setNewPrompt('')
      setNewPriority('normal')
      setShowAdd(false)
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [newName, newPrompt, newPriority, snap])

  if (!open) return null

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }
  const isPage = variant === 'page'

  const node = (
    <div
      className={isPage
        ? 'h-full w-full flex flex-col bg-bg'
        : 'fixed inset-0 z-50 flex items-center justify-center bg-black/60'}
      onClick={isPage ? undefined : onBackdrop}
      data-testid="background-agents-backdrop"
    >
      <div
        ref={dialogRef}
        role={isPage ? undefined : 'dialog'}
        aria-modal={isPage ? undefined : 'true'}
        aria-label="Background Agents"
        className={isPage
          ? 'h-full w-full flex flex-col outline-none bg-bg'
          : 'bg-bg-elev border border-line rounded-lg shadow-xl w-[900px] max-w-[95vw] max-h-[85vh] flex flex-col outline-none'}
        data-testid="background-agents-dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-medium text-fg">Background Agents</h2>
            <div className="text-xs text-fg-dim">
              <span>{counts.running} running</span>
              <span className="mx-1">/</span>
              <span>{counts.pending} queued</span>
              {counts.completed > 0 && (
                <>
                  <span className="mx-1">·</span>
                  <span>{counts.completed} done</span>
                </>
              )}
              {counts.failed > 0 && (
                <>
                  <span className="mx-1">·</span>
                  <span className="text-red-400">{counts.failed} failed</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className="px-2 py-1 rounded text-fg-dim hover:bg-bg-hi hover:text-fg text-xs"
              title="Settings"
            >
              Settings
            </button>
            <button
              type="button"
              onClick={handleOpenFolder}
              className="px-2 py-1 rounded text-fg-dim hover:bg-bg-hi hover:text-fg text-xs"
              title="Open scheduler folder"
            >
              Open Folder
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 rounded text-fg-dim hover:bg-bg-hi hover:text-fg text-xs"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Settings */}
        {showSettings && (
          <div className="px-4 py-3 border-b border-line bg-bg-hi/40">
            <div className="flex items-center gap-3">
              <label className="text-xs text-fg-dim">Max concurrent:</label>
              <select
                value={snap?.config.concurrencyCap ?? 5}
                onChange={(e) => handleSetMaxConcurrent(parseInt(e.target.value, 10))}
                className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <div className="flex-1" />
              <button
                type="button"
                onClick={handleClearCompleted}
                className="text-xs text-fg-dim hover:text-fg"
              >
                Clear Completed
              </button>
            </div>
            <div className="text-xs text-fg-faint mt-2">
              Tasks are PRDs in ~/.claude/session-manager/scheduled-plans/prds/.
              Open the folder to delete or edit them directly.
            </div>
          </div>
        )}

        {/* Queue controls */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          {isQueueRunning ? (
            <button
              type="button"
              onClick={handlePauseQueue}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-yellow-500/15 hover:bg-yellow-500/25 text-yellow-300 text-xs disabled:opacity-50"
            >
              Pause Queue
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartQueue}
              disabled={busy}
              className="px-3 py-1.5 rounded bg-green-500/15 hover:bg-green-500/25 text-green-300 text-xs disabled:opacity-50"
            >
              Start Queue
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="px-3 py-1.5 rounded bg-bg-hi hover:bg-bg-hi/70 text-fg text-xs"
          >
            + Add Task
          </button>
          {snap?.paused && (
            <span className="text-xs text-yellow-300 ml-2">
              Paused: {snap.paused.reason}
            </span>
          )}
          {prdList.length > 0 && (
            <span className="text-xs text-fg-faint ml-auto">
              {prdList.length} PRD{prdList.length === 1 ? '' : 's'} on disk
            </span>
          )}
        </div>

        {/* Add form */}
        {showAdd && (
          <div className="px-4 py-3 border-b border-line bg-bg-hi/30">
            <div className="space-y-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Task name (becomes the PRD filename)…"
                className="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-fg placeholder-fg-faint"
              />
              <textarea
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder="What should Claude do? (Full PRD body — multi-line OK.)"
                rows={4}
                className="w-full bg-bg border border-line rounded px-3 py-1.5 text-sm text-fg placeholder-fg-faint resize-none font-mono"
              />
              <div className="flex items-center gap-3">
                <label className="text-xs text-fg-dim">Priority:</label>
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value as Priority)}
                  className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg"
                >
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
                <div className="flex-1" />
                {addError && <span className="text-xs text-red-400">{addError}</span>}
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setAddError(null) }}
                  className="px-3 py-1 text-xs text-fg-dim hover:text-fg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={busy || !newName.trim() || !newPrompt.trim()}
                  className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent/80 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add Task
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Task list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[180px]">
          {visibleJobs.length === 0 ? (
            <div className="text-center text-fg-faint py-12">
              <div className="text-sm mb-1">No background tasks</div>
              <div className="text-xs">Add a task to queue Claude work in the background</div>
            </div>
          ) : (
            visibleJobs.map((job) => {
              const row = rows[job.slug]
              const expanded = !!row?.expanded
              const priority = groupToPriority(job.parallelGroup)
              return (
                <div
                  key={job.slug}
                  className="bg-bg/60 rounded border border-line overflow-hidden"
                >
                  {/* Row header */}
                  <div
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-hi/40"
                    onClick={() => toggleExpanded(job)}
                  >
                    <span className="text-fg-dim text-xs w-4">{expanded ? '▾' : '▸'}</span>
                    <StatusBadge status={job.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-fg truncate">{job.title}</span>
                        <span className={`text-[10px] uppercase tracking-wider ${
                          priority === 'high' ? 'text-red-400' :
                          priority === 'normal' ? 'text-blue-400' :
                          'text-fg-faint'
                        }`}>
                          {priority}
                        </span>
                      </div>
                      <div className="text-xs text-fg-faint truncate font-mono">
                        {job.slug}{job.cwd ? ` · ${job.cwd}` : ''}
                      </div>
                    </div>
                    <div className="text-xs text-fg-faint font-mono">
                      {formatDuration(job.startedAt, job.finishedAt, now)}
                    </div>
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {job.status === 'pending' && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleSetPriority(job, 'high')}
                            disabled={priority === 'high'}
                            className="px-1.5 py-0.5 rounded text-xs text-fg-dim hover:bg-bg-hi hover:text-fg disabled:opacity-30"
                            title="Increase priority"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSetPriority(job, 'low')}
                            disabled={priority === 'low'}
                            className="px-1.5 py-0.5 rounded text-xs text-fg-dim hover:bg-bg-hi hover:text-fg disabled:opacity-30"
                            title="Decrease priority"
                          >
                            ↓
                          </button>
                        </>
                      )}
                      {(job.status === 'failed') && (
                        <button
                          type="button"
                          onClick={() => handleRetry(job.slug)}
                          className="px-1.5 py-0.5 rounded text-xs text-yellow-400 hover:bg-bg-hi"
                          title="Retry"
                        >
                          ↻
                        </button>
                      )}
                      {(job.status === 'completed' || job.status === 'failed') && (
                        <button
                          type="button"
                          onClick={() => handleRemoveTask(job.slug)}
                          className="px-1.5 py-0.5 rounded text-xs text-fg-dim hover:bg-bg-hi hover:text-red-400"
                          title="Hide from list (does not delete the .md)"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded output */}
                  {expanded && (
                    <div className="border-t border-line">
                      <div className="bg-bg p-3 max-h-[240px] overflow-y-auto font-mono text-xs text-fg-dim whitespace-pre-wrap">
                        {row?.loadingLog
                          ? '(loading log…)'
                          : (row?.logText ?? '(no output yet)')}
                      </div>
                      {job.error && (
                        <div className="px-3 py-2 bg-red-500/10 text-red-400 text-xs">
                          Error: {job.error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )

  if (!isPage && typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}

function StatusBadge({ status }: { status: ScheduleJob['status'] }) {
  const style = {
    pending: { ch: '⏱', cls: 'text-yellow-400' },
    running: { ch: '◐', cls: 'text-blue-400 animate-pulse' },
    completed: { ch: '✓', cls: 'text-green-400' },
    failed: { ch: '✕', cls: 'text-red-400' },
    needs_review: { ch: '⚠', cls: 'text-orange-400' },
  }[status] ?? { ch: '?', cls: 'text-fg-faint' }
  return <span className={`text-sm w-4 text-center ${style.cls}`}>{style.ch}</span>
}

export default BackgroundAgentsModal
