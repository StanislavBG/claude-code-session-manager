import { useEffect, useState } from 'react'
import { CARD, SectionHead } from '../analytics-primitives'
import { useToast } from '../../../../../state/toast'

type ValidationQualityResult = Awaited<ReturnType<Window['api']['history']['validationQuality']>>
type Project = Extract<ValidationQualityResult, { ok: true }>['projects'][number]
type Metric = 'firstPass' | 'refuted' | 'fixWaves' | 'escapes'

const EM_DASH = '—'

/**
 * One-line meaning per miss kind. Mirrors MISS_KIND_MEANINGS in
 * src/main/lib/scheduler/validatorVerdictSchema.cjs (CommonJS, so the renderer
 * cannot import it); the test asserts both key lists match.
 */
export const MISS_KIND_MEANINGS: Readonly<Record<string, string>> = Object.freeze({
  'not-landed': 'nothing or the wrong thing was committed',
  'gate-red': 'a gate command fails',
  'behavior-wrong': 'runs but does not do what a criterion says',
  'not-checked-live': 'passes tests, wrong against real data or the real UI',
  'missing-test': 'a criterion or change has no test that checks it',
  regression: 'breaks something that worked',
  'spec-gap': 'every criterion met but the goal is not',
  security: 'introduces a security problem',
  'docs-drift': 'docs no longer match the code',
  other: 'none of the above',
})

export const APPROVAL_LINE =
  'Proposed for a human to approve: add it to standards.md or the validator persona through /develop.'

const pctText = (n: number | null) => (n == null ? EM_DASH : `${n}%`)

function metricText(p: Project, m: Metric): string {
  switch (m) {
    case 'firstPass':
      return pctText(p.firstPass.pct)
    case 'refuted':
      return pctText(p.refuted.pct)
    case 'fixWaves':
      return p.fixWaves.perPlan == null ? EM_DASH : String(p.fixWaves.perPlan)
    case 'escapes':
      return String(p.escapes.length)
  }
}

function metricItems(p: Project, m: Metric): string[] {
  switch (m) {
    case 'firstPass':
      return p.firstPass.prds
    case 'refuted':
      return p.refuted.prds
    case 'fixWaves':
      return p.fixWaves.plans
        .filter((x) => x.fixWaves.length > 0)
        .map((x) => `${x.plan}: ${x.fixWaves.join(', ')}`)
    case 'escapes':
      return p.escapes.map((e) => `${e.fixPrd} fixes ${e.escapedPrd} — ${e.reason ?? EM_DASH}`)
  }
}

const METRICS: { key: Metric; label: string }[] = [
  { key: 'firstPass', label: 'First-pass verified' },
  { key: 'refuted', label: 'Refuted' },
  { key: 'fixWaves', label: 'Fix waves / plan' },
  { key: 'escapes', label: 'Escapes' },
]

export function ValidationQuality() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<{ cwd: string; metric: Metric } | null>(null)
  const show = useToast((s) => s.show)

  useEffect(() => {
    let alive = true
    const fail = (msg: string) => {
      if (!alive) return
      setError(msg)
      show('error', `Validation quality failed to load: ${msg}`)
    }
    const load = () => {
      window.api.history
        .validationQuality()
        .then((r) => {
          if (!alive) return
          if (!r.ok) return fail(r.error)
          setProjects(r.projects)
          setError(null)
        })
        .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
    }
    load()
    const off = window.api.history.onUpdated(load)
    return () => {
      alive = false
      off()
    }
  }, [show])

  let body
  if (error && !projects) {
    body = <div data-testid="val-q-error" className="text-[11px] font-mono text-fg-faint">Failed to load: {error}</div>
  } else if (!projects) {
    body = <div data-testid="val-q-loading" className="text-[11px] font-mono text-fg-faint">Loading…</div>
  } else if (projects.length === 0) {
    body = <div data-testid="val-q-empty" className="text-[11px] font-mono text-fg-faint">No validated PRDs yet.</div>
  } else {
    const openProject = open ? projects.find((p) => p.cwd === open.cwd) : undefined
    const openItems = open && openProject ? metricItems(openProject, open.metric) : null
    const misses = projects.filter((p) => p.week.topMiss)
    body = (
      <>
        <table className="w-full text-[11px] font-mono" data-testid="val-q-table">
          <thead>
            <tr className="text-fg-faint text-left">
              <th className="font-normal">Project</th>
              {METRICS.map((m) => (
                <th key={m.key} className="font-normal text-right">{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="text-fg-dim">
            {projects.map((p) => (
              <tr key={p.cwd} data-testid="val-q-row">
                <td>{p.project}</td>
                {METRICS.map((m) => {
                  const isOpen = open?.cwd === p.cwd && open.metric === m.key
                  return (
                    <td key={m.key} className="text-right">
                      <button
                        type="button"
                        data-testid={`val-q-${m.key}`}
                        aria-expanded={isOpen}
                        className="underline decoration-dotted hover:text-fg"
                        onClick={() => setOpen(isOpen ? null : { cwd: p.cwd, metric: m.key })}
                      >
                        {metricText(p, m.key)}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {open && openProject && openItems && (
          <div data-testid="val-q-detail" className="mt-2 text-[11px] font-mono text-fg-dim">
            <div className="text-fg-faint">
              {openProject.project} · {METRICS.find((m) => m.key === open.metric)?.label}
            </div>
            {openItems.length === 0 ? (
              <div className="text-fg-faint">No PRDs.</div>
            ) : (
              <ul>
                {openItems.map((s) => (
                  <li key={s} data-testid="val-q-detail-item">{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div data-testid="val-q-week" className="mt-3 text-[11px] font-mono text-fg-dim">
          <div className="text-fg-faint">This week</div>
          {misses.length === 0 ? (
            <div data-testid="val-q-week-empty">No validator misses this week.</div>
          ) : (
            misses.map((p) => {
              const t = p.week.topMiss!
              return (
                <div key={p.cwd} data-testid="val-q-top-miss" className="mt-1">
                  <div>
                    {p.project}: <span className="text-fg">{t.missKind}</span> — {MISS_KIND_MEANINGS[t.missKind] ?? EM_DASH} ·{' '}
                    {t.count}×
                  </div>
                  <div>PRDs: {t.prds.join(', ')}</div>
                  {t.reasons.length > 0 && (
                    <ul className="list-disc pl-4">
                      {t.reasons.slice(0, 5).map((r) => (
                        <li key={r} data-testid="val-q-reason">{r}</li>
                      ))}
                    </ul>
                  )}
                  <div data-testid="val-q-proposal">Proposed check: {t.proposal}</div>
                  <div className="text-fg-faint">{APPROVAL_LINE}</div>
                </div>
              )
            })
          )}
        </div>
      </>
    )
  }

  return (
    <div className={`${CARD} p-4`} data-testid="validation-quality">
      <SectionHead kicker="07 · reliability" title="Validation quality" />
      {body}
    </div>
  )
}
