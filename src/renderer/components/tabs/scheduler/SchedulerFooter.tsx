import { useEffect, useState } from 'react'
import type { ScheduleHealthSnapshot, LintQueueResult } from '../../../../preload/api.d'
import { formatRelative, formatClock, formatAgo } from '../../../lib/formatTime'
import { getLintQueueCached } from '../../../lib/lintQueueCache'
import { InfoDot } from './sched-primitives'

interface Props {
  health: ScheduleHealthSnapshot | null
  jobCount: number
  lastRunAt: string | null
  nextReset: string | null
  now: number
  onOpenSupervisor: () => void
}

/**
 * Footer diagnostics band (2A) — replaces the old DiagnosticsSection block AND the old
 * reset / last-run / supervisor / folder footer row. Where each old line went:
 *  - 'N poll failures in current streak' (health.consecutiveFailures) → band, left summary
 *  - 'queue lint N errors, N warns' (getLintQueueCached)        → band, left summary ('graph lint …')
 *  - booted / last poll / retry in / cached reset / running pids → ⓘ detail, first block
 *  - per-PRD lint findings + 'rerun lint' (fresh: true)          → ⓘ detail, second block
 *  - 'reset …' / 'last run … ago' (snapshot.nextReset/lastRunAt) → band, right, mono
 *  - 'supervisor' / 'folder' links                               → band, right, accent links
 */
export function SchedulerFooter({ health, jobCount, lastRunAt, nextReset, now, onOpenSupervisor }: Props) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<LintQueueResult | null>(null)
  const [lintLoading, setLintLoading] = useState(false)

  // Re-scan (cached) when the queue size or last run changes — never on every render.
  const signal = `${jobCount}:${lastRunAt ?? ''}`
  useEffect(() => {
    let alive = true
    setLintLoading(true)
    getLintQueueCached()
      .then((r) => { if (alive) setReport(r) })
      .catch(() => { /* */ })
      .finally(() => { if (alive) setLintLoading(false) })
    return () => { alive = false }
  }, [signal])

  let lintErrors = 0
  let lintWarns = 0
  const flaggedPrds = report ? report.reports.filter((r) => r.findings.length > 0) : []
  for (const r of flaggedPrds) {
    for (const f of r.findings) {
      if (f.severity === 'error') lintErrors++
      else lintWarns++
    }
  }
  const lintClean = lintErrors === 0 && lintWarns === 0
  const lintLabel = report
    ? `graph lint ${lintErrors} error${lintErrors === 1 ? '' : 's'}, ${lintWarns} warn${lintWarns === 1 ? '' : 's'}`
    : `graph lint ${lintLoading ? 'scanning…' : 'idle'}`
  // consecutiveFailures is persisted across restarts (scheduler-state.json) — it's the
  // current failure STREAK, not a since-boot count, so the label must not claim "since boot".
  const pollFailures = health?.consecutiveFailures ?? 0
  const pollLabel = health ? `${pollFailures} poll failure${pollFailures === 1 ? '' : 's'} in current streak` : null
  const summary = [pollLabel, lintLabel].filter(Boolean).join(' · ')

  const link = 'text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer text-[12px]'
  return (
    <div data-testid="scheduler-footer" className="border-t border-rule-structural">
      <div className="h-[28px] flex items-center gap-2 px-[18px] font-mono text-[11.5px] text-fg-faint">
        <span data-testid="footer-summary" className="truncate">{summary}</span>
        <button
          type="button"
          data-testid="footer-info"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="bg-transparent border-0 p-0 cursor-pointer"
        >
          <InfoDot title="Scheduler poll health and queue-lint findings — click for the full detail" />
        </button>
        <span className="ml-auto flex items-center gap-3 shrink-0">
          <span data-testid="footer-timing">
            {nextReset ? <span title={`next 5h reset: ${nextReset}`}>reset {formatRelative(Date.parse(nextReset) - now)}</span> : null}
            {nextReset && lastRunAt ? ' · ' : null}
            {lastRunAt ? <span title={lastRunAt}>last run {formatRelative(now - Date.parse(lastRunAt))} ago</span> : null}
          </span>
          <button type="button" data-testid="footer-supervisor" onClick={onOpenSupervisor} title="Open supervisor log and settings" className={link}>supervisor</button>
          <button type="button" data-testid="footer-folder" onClick={() => window.api.schedule.openFolder()} className={link}>folder</button>
        </span>
      </div>
      {open && (
        <div data-testid="footer-detail" className="px-[18px] pb-2 space-y-2 font-mono text-[12px] text-fg-dim border-t border-rule-inner pt-2">
          {health && (
            <div className="space-y-0.5">
              <div>booted: {formatAgo(health.bootedAt, now)}</div>
              <div>last poll: {formatAgo(health.lastPollAt, now)} · {health.lastPollOk ? 'ok' : 'failed'}</div>
              {health.backoffNextAt !== null && health.backoffNextAt > now && (
                <div>retry in: {formatRelative(health.backoffNextAt - now)}</div>
              )}
              {health.nextResetCached && (
                <div>cached reset: {formatClock(Date.parse(health.nextResetCached))}</div>
              )}
              {health.runningJobs.length > 0 && (
                <div>running: {health.runningJobs.map((j) => `${j.slug}(pid ${j.pid})`).join(', ')}</div>
              )}
            </div>
          )}
          {report && (
            <div className="space-y-1">
              {lintClean ? (
                <div className="text-sage">✓ no issues in {report.reports.length} PRD{report.reports.length !== 1 ? 's' : ''}</div>
              ) : (
                flaggedPrds.map((r) => (
                  <div key={r.slug}>
                    <div className="text-fg-dim truncate" title={r.slug}>{r.slug}</div>
                    {r.findings.map((f, i) => (
                      <div
                        key={`${r.slug}-${i}`}
                        className={`pl-3 truncate ${f.severity === 'error' ? 'text-accent/80' : 'text-butter/90'}`}
                        title={f.snippet}
                      >
                        {f.severity === 'error' ? '✗' : '⚠'} L{f.line}: {f.snippet}
                      </div>
                    ))}
                  </div>
                ))
              )}
              <button
                type="button"
                data-testid="footer-rerun-lint"
                onClick={() => {
                  setLintLoading(true)
                  getLintQueueCached({ fresh: true }).then(setReport).catch(() => {}).finally(() => setLintLoading(false))
                }}
                className="text-fg-faint hover:text-fg-dim underline"
              >
                {lintLoading ? '…' : 'rerun lint'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
