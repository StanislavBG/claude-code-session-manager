import { useEffect, useMemo, useState } from 'react'
import type { ScheduleStateSnapshot, RetagPrdItem } from '../../../../preload/api'
import { ProjectTag, EpicTag, prdNumber, PrdNumberBadge, prdStatusFor, PrdStatusPill, verdictLabel } from '../scheduler/sched-primitives'
import { EmptyState } from '../../ui/EmptyState'
import { Modal } from '../../ui/Modal'
import { Tooltip } from '../../ui/Tooltip'
import { serializePrdFile } from '../../../lib/prdFrontmatter'
import { formatAgo } from '../../../lib/formatTime'
import { toast } from '../../../state/toast'
import { useScheduleState } from '../../../state/scheduleState'
import { usePromptSessions } from '../../../state/promptSessions'
import { resolveEpicRef } from '../../../lib/epicProvenance'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { takePendingPrdSlug } from '../../../lib/prdDeepLink'
import { useEditor } from '../../../state/editor'
import { EditorView } from '../EditorView'

interface PrdMeta {
  slug: string
  parallelGroup: number
  title: string
  cwd: string
  estimateMinutes: number | null
  mtimeMs: number
  /** Epic linkage — see lib/epicProvenance. Already returned by list-prds;
   *  this view used to drop both fields, which is why a PRD showed no Epic
   *  here while the same PRD's queue row showed one. */
  epicId?: string | null
  sourcePromptId?: string | null
  archived?: boolean
}

/**
 * This view is a live editor over `prds/`'s .md files — `prdAbsPath()`
 * below resolves an edit path directly under that dir — so an archived
 * PRD (already moved to `prds-archived/`) is excluded at every fetch site,
 * not just the initial one, or a card would render a broken "open PRD"
 * link (most visibly right after `confirmArchive()` calls `refreshPrds()`
 * on the very PRDs it just archived). Archived PRDs still show up via
 * useScheduledPrds() in the Epics workspace (EpicDetail's PRDs tab).
 */
function excludeArchived(list: PrdMeta[]): PrdMeta[] {
  return list.filter((p) => !p.archived)
}

/** Deep-link into the Epic workspace, same handler the Queue rows use. */
function openEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

function TBtn({
  label,
  tip,
  onClick,
  disabled,
  primary,
}: {
  label: string
  tip: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Tooltip content={tip} align="bottom-center">
      <button
        title={tip}
        onClick={onClick}
        disabled={disabled}
        className={`px-2 py-0.5 text-xs rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
          primary
            ? 'text-accent border-accent/50 hover:bg-bg-hi'
            : 'text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
        }`}
      >
        {label}
      </button>
    </Tooltip>
  )
}

export function SchedulerPrdsView({ scopeCwd = null }: { scopeCwd?: string | null }) {
  const [prds, setPrds] = useState<PrdMeta[]>([])
  const [queueState, setQueueState] = useState<ScheduleStateSnapshot | null>(null)
  // `selectedSlug` is the PRD currently open in the editor pane below (null =
  // card list is showing). Card metadata (title/cwd/estimateMinutes/mtime)
  // comes from `prds`/PrdMeta via listPrds(), never from this.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [logText, setLogText] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [loading, setLoading] = useState(true)
  // Bundle D — multi-select state. Set semantics avoid accidental O(N^2) on
  // toggle for the ~200-PRD list seen in practice.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [retagOpen, setRetagOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.schedule
      .listPrds()
      .then((list) => {
        if (alive) {
          setPrds(excludeArchived(list))
          setLoading(false)
        }
      })
      .catch((e) => {
        if (alive) {
          setLoading(false)
          toast.error(`Scheduler: failed to load PRD list — ${e instanceof Error ? e.message : 'unknown error'}`)
        }
      })
    // Schedule snapshot is owned by state/scheduleState.ts; subscribe via
    // useScheduleState() above and mirror into queueState (kept as local
    // state so existing render logic doesn't change).
    return () => {
      alive = false
    }
  }, [])

  const liveSnap = useScheduleState((s) => s.snapshot)
  // Raw slice — never derive inside a zustand selector (React #185 class).
  const epicSessions = usePromptSessions((s) => s.sessions)
  useEffect(() => {
    if (liveSnap) setQueueState(liveSnap)
  }, [liveSnap])

  // Latest-addition-on-top. mtimeMs captures both new files and freshly
  // edited ones, which matches "latest" better than slug order (slugs lead
  // with the parallel group prefix, not creation order).
  const sortedPrds = useMemo(
    () => [...prds]
      .filter((p) => !scopeCwd || p.cwd === scopeCwd)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug)),
    [prds, scopeCwd],
  )

  // Cross-tab deep link: TerminalChat's queue panel (PRD 750) navigates here
  // to jump straight to a dispatched-to-prd ticket's PRD. `takePendingPrdSlug`
  // covers the common case — this component wasn't mounted yet when the link
  // was clicked, so it missed the live event — by checking once on mount;
  // the listener below covers the case where Scheduler was already open.
  useEffect(() => {
    const pendingSlug = takePendingPrdSlug()
    if (pendingSlug) setSelectedSlug(pendingSlug)
    const h = (e: Event) => setSelectedSlug((e as CustomEvent<string>).detail)
    window.addEventListener('sm:select-prd', h)
    return () => window.removeEventListener('sm:select-prd', h)
  }, [])

  const job = useMemo(
    () => queueState?.jobs.find((j) => j.slug === selectedSlug) ?? null,
    [queueState, selectedSlug],
  )
  const status = prdStatusFor(job)

  function prdAbsPath(slug: string): string | null {
    const cwd = prds.find((p) => p.slug === slug)?.cwd
    return cwd ? `${cwd}/session-manager-operations/scheduler/prds/${slug}.md` : null
  }

  // Opening a PRD is the single entry point into view+edit: it drives the
  // shared editor store (also used by the Projects/File-Explorer tab) and
  // shows selectedSlug's toolbar (status/Run now/Last run log) above it.
  // `useEditor` is a multi-tab store (openFile appends rather than replaces),
  // so browsing PRDs here adds tabs to the same shared strip the Projects tab
  // renders — a PRD opened here shows up as a tab there too. That's the
  // acceptable, non-surprising part; this effect (rather than opening inline
  // in the click handler) exists so a PRD opened before `prds` resolves —
  // via the cross-tab deep link above, or a very early click — still opens
  // once listPrds() (which supplies the per-slug cwd prdAbsPath needs)
  // round-trips, instead of silently leaving the editor pane on its "no file
  // open" empty state.
  useEffect(() => {
    if (!selectedSlug) return
    const absPath = prdAbsPath(selectedSlug)
    if (absPath) useEditor.getState().openFile(absPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlug, prds])

  function openPrd(slug: string) {
    setSelectedSlug(slug)
    setLogText(null)
    setShowLog(false)
  }

  function closeEditor() {
    setSelectedSlug(null)
  }

  async function handleShowLog() {
    if (!selectedSlug) return
    if (!job?.runId) {
      setLogText('no log available (job has not run yet)')
      setShowLog((v) => !v)
      return
    }
    const res = await window.api.schedule.readLog(job.runId, selectedSlug)
    setLogText(res.ok ? (res.text ?? '') : `error: ${res.error}`)
    setShowLog((v) => !v)
  }

  if (loading) return <EmptyState title="loading PRDs…" />

  // Bundle D — multi-select handlers.
  const toggleChecked = (slug: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  const allVisibleChecked = sortedPrds.length > 0 && sortedPrds.every((p) => checked.has(p.slug))
  const someVisibleChecked = !allVisibleChecked && sortedPrds.some((p) => checked.has(p.slug))
  const toggleAllVisible = () => {
    setChecked((prev) => {
      if (allVisibleChecked) {
        const next = new Set(prev)
        for (const p of sortedPrds) next.delete(p.slug)
        return next
      }
      const next = new Set(prev)
      for (const p of sortedPrds) next.add(p.slug)
      return next
    })
  }
  const clearChecked = () => setChecked(new Set())

  async function refreshPrds() {
    try {
      const list = await window.api.schedule.listPrds()
      setPrds(excludeArchived(list))
    } catch { /* */ }
  }

  // Reset N pending: idempotent per-slug calls. resetJob is already
  // serialized in scheduler.cjs's mutate() so concurrency is safe.
  async function bulkReset() {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const slugs = [...checked]
      for (const slug of slugs) {
        await window.api.schedule.resetJob(slug)
      }
      clearChecked()
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleNewPrd() {
    const slug = `new-prd-${Date.now()}`
    const template = serializePrdFile(
      { title: 'New PRD', cwd: '', estimateMinutes: 60, parallelGroup: 99 },
      '## Task\n\nDescribe the task here.\n',
    )
    try {
      const res = await window.api.schedule.writePrd(slug, template)
      if (!res.ok) {
        toast.error(`Failed to create PRD: ${res.error}`)
        return
      }
      const list = await window.api.schedule.listPrds()
      setPrds(excludeArchived(list))
      openPrd(slug)
    } catch (e: unknown) {
      toast.error(`Failed to create PRD: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function confirmArchive() {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const slugs = [...checked]
      const res = await window.api.schedule.archivePrds(slugs)
      if (!res.ok) {
        setBulkError(res.error ?? 'archive failed')
      } else {
        const failed = res.results?.filter((r: { ok: boolean }) => !r.ok) ?? []
        if (failed.length > 0) {
          toast.warn(`Archive: ${failed.length} of ${res.results.length} PRD${failed.length === 1 ? '' : 's'} failed to move`)
        }
        clearChecked()
        setArchiveOpen(false)
        await refreshPrds()
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  async function confirmRetag(parallelGroup: number | null, estimateMinutes: number | null) {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const items: RetagPrdItem[] = []
      for (const slug of checked) {
        const item: RetagPrdItem = { slug }
        if (parallelGroup !== null) item.parallelGroup = parallelGroup
        if (estimateMinutes !== null) item.estimateMinutes = estimateMinutes
        items.push(item)
      }
      const res = await window.api.schedule.retagPrds(items)
      if (!res.ok) {
        setBulkError(res.error ?? 'retag failed')
      } else {
        clearChecked()
        setRetagOpen(false)
        await refreshPrds()
        // A parallelGroup change renames the underlying file. Remap any open
        // editor tab to the new path so it doesn't keep pointing at a file
        // that no longer exists on disk.
        for (const r of res.results) {
          if (r.newSlug && r.newSlug !== r.slug) {
            const oldPath = prdAbsPath(r.slug)
            const newPath = prdAbsPath(r.newSlug)
            if (oldPath && newPath) useEditor.getState().renameOpenFile(oldPath, newPath)
          }
        }
        // If the currently-selected slug was retagged with a parallelGroup
        // change, its slug may have moved; clear selection.
        if (selectedSlug && res.results.some((r) => r.slug === selectedSlug && r.newSlug && r.newSlug !== r.slug)) {
          setSelectedSlug(null)
        }
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <>
      {selectedSlug ? (
        // ── Editor view ──────────────────────────────────────────────────────
        // Full-body view+edit is delegated entirely to the shared EditorView /
        // useEditor store (same surface the Projects/File-Explorer tab uses).
        // Only PRD-specific, non-file-editing actions stay here.
        <div className="h-full flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap shrink-0">
            <button
              type="button"
              onClick={closeEditor}
              className="text-[11px] text-fg-faint hover:text-fg"
            >
              ← PRDs
            </button>
            <span className="font-mono text-xs text-fg-dim truncate">{selectedSlug}</span>
            <PrdStatusPill status={status} />
            <div className="flex-1" />
            <TBtn
              label="Reset"
              tip="Reset failed job to pending"
              onClick={() => { window.api.schedule.resetJob(selectedSlug) }}
              disabled={status !== 'failed'}
            />
            <TBtn
              label="Run now"
              tip="Run all pending jobs immediately"
              onClick={() => { window.api.schedule.runNow() }}
            />
            <TBtn
              label={showLog ? 'Hide log' : 'Last run log'}
              tip="Toggle most recent run log"
              onClick={handleShowLog}
            />
          </div>

          <div className="flex-1 min-h-0">
            <EditorView />
          </div>

          {showLog && logText !== null && (
            <div className="border-t border-line max-h-64 overflow-auto bg-bg-elev">
              <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line sticky top-0 bg-bg-elev">
                <span className="text-[10px] text-fg-faint font-mono">
                  run log{job?.runId ? ` — ${job.runId}` : ''}
                </span>
                <button
                  onClick={() => setShowLog(false)}
                  className="ml-auto text-[10px] text-fg-faint hover:text-fg"
                >
                  close
                </button>
              </div>
              <pre className="p-3 text-[11px] font-mono text-fg-dim whitespace-pre-wrap">
                {logText}
              </pre>
            </div>
          )}
        </div>
      ) : (
        // ── Card list ────────────────────────────────────────────────────────
        <div className="px-6 py-5 overflow-auto">
          <div className="flex items-start justify-between mb-5 gap-4">
            <p className="text-[14px] text-fg-dim leading-relaxed max-w-[560px]">
              PRDs are the source the scheduler runs from. Each one becomes a{' '}
              <code className="font-mono text-[13px]">claude -p</code> job when you queue it.
              This is where you write and edit the source — to watch a run in progress, use the Queue tab.
            </p>
            <button
              type="button"
              onClick={handleNewPrd}
              className="shrink-0 bg-accent text-white rounded-lg px-4 py-[9px] text-[13.5px] font-semibold leading-none"
            >
              + New PRD
            </button>
          </div>

          {checked.size > 0 && (
            <div className="mb-4 px-4 py-2 bg-bg border border-line rounded-lg flex items-center gap-2">
              <span className="text-xs text-fg-dim">{checked.size} selected</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                className="text-xs px-3 py-1.5 rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
              >
                Archive…
              </button>
              <button
                type="button"
                onClick={() => setRetagOpen(true)}
                className="text-xs px-3 py-1.5 rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
              >
                Retag…
              </button>
              <button
                type="button"
                onClick={clearChecked}
                className="text-xs px-3 py-1.5 rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
              >
                Clear
              </button>
            </div>
          )}

          {sortedPrds.length === 0 ? (
            <EmptyState title="no PRDs found" />
          ) : (
            <div className="grid gap-3">
              {sortedPrds.map((p) => {
                const j = queueState?.jobs.find((jj) => jj.slug === p.slug)
                const prdStatus = prdStatusFor(j)
                // The PRD file and its queue row can each carry linkage; the
                // file's own epicId (its directory) wins, per epicProvenance.
                const epicRef = resolveEpicRef(
                  {
                    epicId: p.epicId ?? j?.epicId ?? null,
                    sourcePromptId: p.sourcePromptId ?? j?.sourcePromptId ?? null,
                    sourceTabId: j?.sourceTabId ?? null,
                  },
                  epicSessions,
                )
                const isRunning = j?.status === 'running'
                const isNeedsReview = j?.status === 'needs_review'
                return (
                  <div
                    key={p.slug}
                    className="flex items-stretch bg-bg-elev border border-line rounded-2xl overflow-hidden"
                  >
                    {/* Checkbox for bulk select */}
                    <label className="flex items-center px-3 cursor-pointer hover:bg-bg-hi">
                      <input
                        type="checkbox"
                        checked={checked.has(p.slug)}
                        onChange={() => toggleChecked(p.slug)}
                        className="accent-accent w-3.5 h-3.5"
                      />
                    </label>
                    {/* Main card content */}
                    <div className="flex-1 min-w-0 py-4 pr-2">
                      <div className="flex items-center gap-2.5 mb-[5px] flex-wrap">
                        {prdNumber(p.slug) && <PrdNumberBadge n={prdNumber(p.slug)!} />}
                        <button
                          type="button"
                          onClick={() => openPrd(p.slug)}
                          className="font-serif text-[18px] font-semibold text-fg leading-tight hover:underline text-left"
                        >
                          {p.title || p.slug}
                        </button>
                        <PrdStatusPill status={prdStatus} />
                        {/* Hidden raw status for screen readers and testability */}
                        {j?.status && <span className="sr-only">{j.status}</span>}
                      </div>
                      <div className="flex items-center gap-4 font-mono text-xs text-fg-faint flex-wrap">
                        <ProjectTag cwd={p.cwd} />
                        <EpicTag epicId={epicRef.epicId} label={epicRef.label} onOpen={openEpic} />
                        {p.estimateMinutes != null && <span>{p.estimateMinutes}m</span>}
                        <span>g{p.parallelGroup}</span>
                        <span>edited {formatAgo(p.mtimeMs, Date.now())}</span>
                      </div>
                      {/* Slug as clickable monospace label — opens the same editor pane */}
                      <button
                        type="button"
                        onClick={() => openPrd(p.slug)}
                        className="mt-1.5 font-mono text-[11px] text-fg-faint hover:text-fg-dim leading-none"
                      >
                        {p.slug}
                      </button>
                      {/* needs_review inline details: verifier verdict + Re-fire */}
                      {isNeedsReview && (
                        <div className="mt-3 space-y-2">
                          {j?.verifierVerdict && (
                            <div className="text-xs text-fg-faint">
                              verdict: <span className="font-mono">{verdictLabel(j.verifierVerdict)}</span>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => window.api.schedule.resetJob(p.slug)}
                            className="text-xs px-2.5 py-1 rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
                          >
                            Re-fire
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Action buttons */}
                    <div className="flex flex-col gap-2 items-stretch px-[18px] py-4">
                      <button
                        type="button"
                        onClick={() => window.api.schedule.runNow()}
                        disabled={isRunning}
                        className="bg-fg text-bg rounded-lg px-[18px] py-2 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50"
                      >
                        {isRunning ? 'Running…' : 'Queue job'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <ArchiveConfirmModal
        open={archiveOpen}
        count={checked.size}
        busy={bulkBusy}
        onClose={() => setArchiveOpen(false)}
        onConfirm={confirmArchive}
      />
      <RetagModal
        open={retagOpen}
        count={checked.size}
        busy={bulkBusy}
        onClose={() => setRetagOpen(false)}
        onConfirm={confirmRetag}
      />
    </>
  )
}

// ─── Bundle D — bulk modals ────────────────────────────────────────────────

function ArchiveConfirmModal({
  open, count, busy, onClose, onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Archive PRDs">
      <p className="text-xs text-fg-dim">
        Move <span className="font-mono">{count}</span> PRD{count === 1 ? '' : 's'} to{' '}
        <span className="font-mono">prds-archived/&lt;timestamp&gt;/</span>?
      </p>
      <p className="text-[10px] text-fg-faint mt-2">
        Files are renamed, never deleted. Restore manually from disk if needed.
      </p>
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-2 py-1 text-xs border border-line rounded text-fg-dim hover:text-fg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || count === 0}
          className="px-2 py-1 text-xs border border-accent/60 text-accent rounded hover:bg-bg-hi disabled:opacity-40"
        >
          {busy ? 'Archiving…' : `Archive ${count}`}
        </button>
      </div>
    </Modal>
  )
}

function RetagModal({
  open, count, busy, onClose, onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (parallelGroup: number | null, estimateMinutes: number | null) => void
}) {
  const [groupStr, setGroupStr] = useState('')
  const [estimateStr, setEstimateStr] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setGroupStr('')
      setEstimateStr('')
      setErr(null)
    }
  }, [open])

  function submit() {
    setErr(null)
    let pg: number | null = null
    let em: number | null = null
    if (groupStr.trim()) {
      const v = Number(groupStr)
      if (!Number.isInteger(v) || v < 0 || v > 999) {
        setErr('parallelGroup must be 0–999')
        return
      }
      pg = v
    }
    if (estimateStr.trim()) {
      const v = Number(estimateStr)
      if (!Number.isInteger(v) || v <= 0) {
        setErr('estimateMinutes must be a positive integer')
        return
      }
      em = v
    }
    if (pg === null && em === null) {
      setErr('set at least one field')
      return
    }
    onConfirm(pg, em)
  }

  return (
    <Modal open={open} onClose={onClose} title="Retag PRDs">
      <p className="text-xs text-fg-dim">
        Update <span className="font-mono">{count}</span> PRD{count === 1 ? '' : 's'}. Leave a field blank to keep its current value.
      </p>
      <p className="text-[10px] text-fg-faint mt-2">
        Changing parallelGroup on an <span className="font-mono">NN-kebab</span> slug renames the file.
        Every change is logged to <span className="font-mono">retag-log.jsonl</span> so it's reversible.
      </p>
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-fg-faint">parallelGroup:</span>
          <input
            type="number"
            min={0}
            max={999}
            value={groupStr}
            onChange={(e) => setGroupStr(e.target.value)}
            placeholder="(unchanged)"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-fg-faint">estimateMinutes:</span>
          <input
            type="number"
            min={1}
            value={estimateStr}
            onChange={(e) => setEstimateStr(e.target.value)}
            placeholder="(unchanged)"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>
      </div>
      {err && <div className="mt-2 text-[10px] text-red-300">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-2 py-1 text-xs border border-line rounded text-fg-dim hover:text-fg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || count === 0}
          className="px-2 py-1 text-xs border border-accent/60 text-accent rounded hover:bg-bg-hi disabled:opacity-40"
        >
          {busy ? 'Retagging…' : `Retag ${count}`}
        </button>
      </div>
    </Modal>
  )
}
