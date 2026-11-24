// Bundle entry for the real-Chromium Scheduler cancelled-row screenshot spec
// (scheduler-cancelled-shots.spec.ts). Mounts the real Scheduler JobRow for three jobs — a
// human-cancelled 'failed' row, a human-cancelled 'needs_review' row and a real failure — each
// followed by the real PrdStatusPill fed by prdStatusFor(job), over a stub window.api.
// `cancelled` is the flag main stamps (lib/scheduler/cancelledRow.cjs); this fixture never
// re-derives it. Nothing here touches a real disk.
import { createRoot } from 'react-dom/client'
import { JobRow } from '../../src/renderer/components/tabs/scheduler/JobRow'
import { PrdStatusPill, prdStatusFor } from '../../src/renderer/components/tabs/scheduler/sched-primitives'
import type { ScheduleJob } from '../../src/preload/api.d'

const CWD = '/home/user/Projects/session-manager'

// `cancelledAt` is carried on the queue row (not on the renderer type) — kept for fidelity.
type FixtureJob = ScheduleJob & { cancelledAt?: string }

const base = (slug: string, title: string): FixtureJob => ({
  slug, title, cwd: CWD, parallelGroup: 1, estimateMinutes: 20, bodyPreview: '',
  status: 'pending', runId: null, startedAt: null, finishedAt: null, exitCode: null, error: null,
})

const JOBS: { id: string; job: FixtureJob }[] = [
  {
    id: 'cancelled-failed',
    job: {
      ...base('3901-cancelled-failed-job', 'Cancelled while running — failed underneath'),
      status: 'failed', cancelled: true, cancelledAt: '2026-11-22T18:04:00Z', error: 'cancelled via admin API',
      startedAt: '2026-11-22T17:51:00Z', finishedAt: '2026-11-22T18:04:00Z', exitCode: 143,
    },
  },
  {
    id: 'cancelled-needs-review',
    job: {
      ...base('3902-cancelled-needs-review-job', 'Cancelled while parked — needs review underneath'),
      status: 'needs_review', cancelled: true, cancelledAt: '2026-11-22T18:10:00Z',
      startedAt: '2026-11-22T17:30:00Z', finishedAt: '2026-11-22T17:48:00Z', exitCode: 0,
    },
  },
  {
    id: 'real-failure',
    job: {
      ...base('3903-real-failure-job', 'Real failure — gate went red'),
      status: 'failed', error: 'exit 1',
      startedAt: '2026-11-22T16:20:00Z', finishedAt: '2026-11-22T16:31:00Z', exitCode: 1,
    },
  },
]

// Anything JobRow reaches for that the fixture doesn't model resolves harmlessly — and is
// logged, so a new dependency shows up in the spec's console capture instead of crashing the mount.
function fallback(target: any, path: string): any {
  return new Proxy(target, {
    get(t, k) {
      if (typeof k === 'symbol' || k in t) {
        const v = t[k as any]
        return v && typeof v === 'object' ? fallback(v, `${path}.${String(k)}`) : v
      }
      console.warn(`[stub-api] unmodelled window.api${path}.${String(k)}`)
      return fallback(async () => undefined, `${path}.${String(k)}`)
    },
  })
}
;(window as any).api = fallback({}, '')

const noop = () => {}

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh' }} className="bg-bg p-6">
    <div role="list" data-testid="cancelled-rows" className="border border-line rounded-lg bg-bg-elev/30">
      {JOBS.map(({ id, job }, i) => (
        <div key={id} data-testid={`cancelled-case-${id}`}>
          <JobRow job={job} eta={null} elapsedMs={null} avgDurationMs={600_000} listIndex={i} onFocused={noop} />
          <div className="flex items-center gap-2 px-[18px] pb-3 text-[12px] text-fg-faint" data-testid="cancelled-case-pill">
            PRD status <PrdStatusPill status={prdStatusFor(job)} />
          </div>
        </div>
      ))}
    </div>
  </div>,
)
