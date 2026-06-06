import { useEffect, useMemo, useState } from 'react'
import type { ScheduleJob } from '../../../../preload/api'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge } from '../../ui/StatusBadge'
import type { JobStatus } from '../../ui/StatusBadge'
import { formatTimingLabel } from '../../../lib/formatTime'
import { RunLogViewer } from './RunLogViewer'

interface HistoryResult {
  ok: boolean
  jobs: ScheduleJob[]
  error?: string
}

/** Map cwd to the last path segment for compact display. */
function projectName(cwd: string | null | undefined): string {
  if (!cwd) return '—'
  const segs = cwd.replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || cwd
}

/** Format a date string as YYYY-MM-DD for comparison with date inputs. */
function toDateStr(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

export function SchedulerHistoryView() {
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [projectFilter, setProjectFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'failed'>('all')

  useEffect(() => {
    setLoading(true)
    window.api.schedule.getHistory()
      .then((r) => setResult(r))
      .catch((e) => setResult({ ok: false, jobs: [], error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setLoading(false))
  }, [])

  // Unique project names for the project filter dropdown
  const projects = useMemo(() => {
    if (!result?.jobs) return []
    const seen = new Set<string>()
    for (const j of result.jobs) {
      const name = projectName(j.cwd)
      if (name !== '—') seen.add(name)
    }
    return [...seen].sort()
  }, [result])

  const filtered = useMemo(() => {
    if (!result?.jobs) return []
    return result.jobs.filter((j) => {
      if (statusFilter !== 'all' && j.status !== statusFilter) return false
      if (projectFilter && projectName(j.cwd) !== projectFilter) return false
      if (fromDate && toDateStr(j.finishedAt) < fromDate) return false
      if (toDate && toDateStr(j.finishedAt) > toDate) return false
      return true
    })
  }, [result, statusFilter, projectFilter, fromDate, toDate])

  if (loading) return <EmptyState title="Loading history…" />

  if (!result?.ok || result.error) {
    return (
      <div className="p-4 text-xs text-red-300">
        Failed to load history: {result?.error ?? 'unknown error'}
      </div>
    )
  }

  if (result.jobs.length === 0) {
    return <EmptyState title="No history yet" hint="Completed and failed jobs appear here." />
  }

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line flex-wrap">
        <div className="flex items-center gap-1 text-[10px] text-fg-faint">
          <span>status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="bg-bg border border-line rounded px-1 py-0.5 text-fg-dim"
          >
            <option value="all">all</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
        </div>
        {projects.length > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-fg-faint">
            <span>project:</span>
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="bg-bg border border-line rounded px-1 py-0.5 text-fg-dim max-w-[12rem]"
            >
              <option value="">all</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1 text-[10px] text-fg-faint">
          <span>from:</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-bg border border-line rounded px-1 py-0.5 text-fg-dim font-mono"
          />
        </div>
        <div className="flex items-center gap-1 text-[10px] text-fg-faint">
          <span>to:</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-bg border border-line rounded px-1 py-0.5 text-fg-dim font-mono"
          />
        </div>
        <span className="text-[10px] text-fg-faint ml-auto font-mono">
          {filtered.length} of {result.jobs.length}
        </span>
        {(statusFilter !== 'all' || projectFilter || fromDate || toDate) && (
          <button
            type="button"
            onClick={() => { setStatusFilter('all'); setProjectFilter(''); setFromDate(''); setToDate('') }}
            className="text-[10px] text-fg-faint hover:text-fg-dim underline"
          >
            clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState title="No matches" hint="Try adjusting the filters." />
        ) : (
          <table className="w-full text-[11px] border-collapse">
            <thead className="sticky top-0 bg-bg-elev border-b border-line">
              <tr>
                <th className="text-left px-3 py-1.5 text-fg-faint font-normal text-[10px] uppercase tracking-wider w-28">Status</th>
                <th className="text-left px-3 py-1.5 text-fg-faint font-normal text-[10px] uppercase tracking-wider">Title</th>
                <th className="text-left px-3 py-1.5 text-fg-faint font-normal text-[10px] uppercase tracking-wider w-28">Project</th>
                <th className="text-left px-3 py-1.5 text-fg-faint font-normal text-[10px] uppercase tracking-wider w-20">Duration</th>
                <th className="text-left px-3 py-1.5 text-fg-faint font-normal text-[10px] uppercase tracking-wider w-36">Finished</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <HistoryRow key={`${j.slug}-${j.finishedAt ?? ''}`} job={j} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function HistoryRow({ job }: { job: ScheduleJob }) {
  const [expanded, setExpanded] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const duration = job.startedAt && job.finishedAt
    ? Date.parse(job.finishedAt) - Date.parse(job.startedAt)
    : null
  const finishedAt = job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '—'
  const isFailed = job.status === 'failed'

  return (
    <>
      <tr
        className={`border-b border-line/40 hover:bg-bg-hi cursor-pointer ${isFailed ? 'bg-red-950/10' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <td className="px-3 py-2">
          <StatusBadge status={job.status as JobStatus} />
        </td>
        <td className="px-3 py-2 text-fg-dim truncate max-w-0 w-full">
          <span className="truncate block">{job.title}</span>
          {isFailed && job.error && !expanded && (
            <span className="text-red-300/70 text-[10px] truncate block">{job.error.slice(0, 80)}</span>
          )}
        </td>
        <td className="px-3 py-2 text-fg-faint font-mono text-[10px] truncate">
          {projectName(job.cwd)}
        </td>
        <td className="px-3 py-2 text-fg-faint font-mono text-[10px]">
          {duration !== null ? formatTimingLabel(duration) : '—'}
        </td>
        <td className="px-3 py-2 text-fg-faint text-[10px]">{finishedAt}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-line/40">
          <td colSpan={5} className="px-4 py-2 bg-bg/60 text-[10px] text-fg-faint">
            <div className="space-y-1 max-w-3xl">
              <div className="font-mono text-fg-faint/60">slug: {job.slug}</div>
              {job.cwd && <div className="font-mono truncate" title={job.cwd}>cwd: {job.cwd}</div>}
              {job.startedAt && <div>started: {new Date(job.startedAt).toLocaleString()}</div>}
              {job.exitCode !== null && (
                <div className={job.exitCode === 0 ? 'text-green-400' : 'text-red-400'}>
                  exit code: {job.exitCode}
                </div>
              )}
              {job.error && (
                <div className="text-red-300/90 break-words whitespace-pre-wrap">{job.error}</div>
              )}
              {job.verifierVerdict && (
                <div className="text-orange-400 font-mono">verifier: {job.verifierVerdict}</div>
              )}
              <div className="flex gap-3 pt-1">
                {job.status !== 'pending' && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); window.api.schedule.resetJob(job.slug) }}
                    className="text-fg-dim hover:text-fg underline"
                  >
                    reset to pending
                  </button>
                )}
                {job.runId && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowLog(true) }}
                    className="text-fg-dim hover:text-fg underline"
                  >
                    view log
                  </button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
      {showLog && job.runId && (
        <RunLogViewer
          runId={job.runId}
          slug={job.slug}
          title={job.title || job.slug}
          onClose={() => setShowLog(false)}
        />
      )}
    </>
  )
}
