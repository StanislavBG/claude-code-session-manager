import { useEffect, useMemo, useState } from 'react'
import type { ScheduleJob } from '../../../../preload/api'
import { EmptyState } from '../../ui/EmptyState'
import { formatTimingLabel } from '../../../lib/formatTime'
import { FilterPills } from '../../ui/FilterPills'
import { RunLogViewer } from './RunLogViewer'
import { SchBadge, ProjectTag, DetailBlock, DetailLine } from '../scheduler/sched-primitives'

interface HistoryResult {
  ok: boolean
  jobs: ScheduleJob[]
  error?: string
}

/** Format a date string as YYYY-MM-DD for comparison with date inputs. */
function toDateStr(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

const STATUS_OPTIONS = [
  { value: 'all',       label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed',    label: 'Failed' },
] as const
type StatusFilter = typeof STATUS_OPTIONS[number]['value']

export function SchedulerHistoryView() {
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [projectFilter, setProjectFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

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
      const name = j.cwd ? (j.cwd.replace(/\/+$/, '').split('/').pop() ?? '') : ''
      if (name) seen.add(name)
    }
    return [...seen].sort()
  }, [result])

  const filtered = useMemo(() => {
    if (!result?.jobs) return []
    return result.jobs.filter((j) => {
      if (statusFilter !== 'all' && j.status !== statusFilter) return false
      if (projectFilter) {
        const name = j.cwd ? (j.cwd.replace(/\/+$/, '').split('/').pop() ?? '') : ''
        if (name !== projectFilter) return false
      }
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

  const hasFilters = statusFilter !== 'all' || !!projectFilter || !!fromDate || !!toDate

  return (
    <div className="h-full flex flex-col">
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-line flex-wrap">
        {/* Status chips */}
        <FilterPills options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} pillPadding="px-3 py-1" />

        <span className="w-px h-4 bg-line mx-1" aria-hidden="true" />

        {projects.length > 0 && (
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-bg-hi border border-line rounded-lg px-2 py-1 text-[12.5px] text-fg-dim max-w-[12rem] font-medium"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-1.5 text-[12px] text-fg-faint">
          <span>from</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-bg-hi border border-line rounded-lg px-2 py-1 text-fg-dim font-mono text-[12px]"
          />
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-fg-faint">
          <span>to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-bg-hi border border-line rounded-lg px-2 py-1 text-fg-dim font-mono text-[12px]"
          />
        </div>

        <span className="text-[12px] text-fg-faint ml-auto font-mono">
          {filtered.length} / {result.jobs.length}
        </span>
        {hasFilters && (
          <button
            type="button"
            onClick={() => { setStatusFilter('all'); setProjectFilter(''); setFromDate(''); setToDate('') }}
            className="text-[12px] text-fg-faint hover:text-fg-dim underline"
          >
            clear
          </button>
        )}
      </div>

      {/* Job list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <EmptyState title="No matches" hint="Try adjusting the filters." />
        ) : (
          <div className="mx-4 my-3 bg-bg-hi border border-line rounded-[14px] overflow-hidden">
            <div className="flex items-center px-[18px] py-3 bg-bg-elev">
              <span className="font-serif text-base font-semibold text-fg">
                {filtered.length} job{filtered.length !== 1 ? 's' : ''}
              </span>
            </div>
            {filtered.map((j) => (
              <HistoryRow key={`${j.slug}-${j.finishedAt ?? ''}`} job={j} />
            ))}
          </div>
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
  const startedStr  = job.startedAt  ? new Date(job.startedAt).toLocaleString()  : '—'
  const finishedStr = job.finishedAt ? new Date(job.finishedAt).toLocaleString() : '—'
  const durationStr = duration !== null ? formatTimingLabel(duration) : '—'
  const exitStr     = job.exitCode !== null ? String(job.exitCode) : '—'

  return (
    <div className="border-t border-line/60">
      <button
        type="button"
        className={`w-full text-left grid items-center gap-4 px-[18px] py-3.5 cursor-pointer transition-colors hover:bg-bg-elev ${expanded ? 'bg-bg-elev' : 'bg-transparent'}`}
        style={{ gridTemplateColumns: '116px 1fr auto auto' }}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <SchBadge status={job.status} />
        <div className="min-w-0">
          <div className="text-[14.5px] font-medium text-fg leading-snug text-pretty">{job.title}</div>
          {job.error && !expanded && (job.status === 'failed' || job.status === 'needs_review') && (
            <div className="text-[12.5px] mt-0.5 text-accent/80 truncate">{job.error}</div>
          )}
        </div>
        <ProjectTag cwd={job.cwd} />
        <span className="inline-flex items-center gap-2.5 font-mono text-xs text-fg-faint whitespace-nowrap">
          {durationStr}
          <span
            className="inline-flex transition-transform duration-150"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
            aria-hidden="true"
          >
            ›
          </span>
        </span>
      </button>

      {expanded && (
        <div
          className="grid gap-5 px-[18px] pt-1 pb-5 bg-bg-elev"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
        >
          <DetailBlock label="Status">
            <DetailLine k="result" v={exitStr} />
            <DetailLine k="state" v={job.status.replace('_', ' ')} />
            {job.verifierVerdict && <DetailLine k="verifier" v={job.verifierVerdict} />}
          </DetailBlock>
          <DetailBlock label="Timing">
            <DetailLine k="started" v={startedStr} />
            <DetailLine k="finished" v={finishedStr} />
            <DetailLine k="duration" v={durationStr} />
          </DetailBlock>
          <DetailBlock label="Location">
            <DetailLine k="group" v={job.parallelGroup != null ? String(job.parallelGroup) : '—'} />
            <DetailLine k="slug" v={job.slug} />
            {job.cwd && <DetailLine k="cwd" v={job.cwd} wrap />}
          </DetailBlock>
          <DetailBlock label="Actions">
            <div className="flex flex-col gap-2 items-start">
              {job.runId && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowLog(true) }}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 p-0 cursor-pointer"
                >
                  view log →
                </button>
              )}
              {job.status !== 'pending' && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void window.api.schedule.resetJob(job.slug) }}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 p-0 cursor-pointer"
                >
                  reset to pending →
                </button>
              )}
              {job.error && (
                <p className="text-[12px] text-accent/90 mt-1 break-words whitespace-pre-wrap max-w-sm m-0">
                  {job.error}
                </p>
              )}
            </div>
          </DetailBlock>
        </div>
      )}

      {showLog && job.runId && (
        <RunLogViewer
          runId={job.runId}
          slug={job.slug}
          title={job.title || job.slug}
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  )
}
