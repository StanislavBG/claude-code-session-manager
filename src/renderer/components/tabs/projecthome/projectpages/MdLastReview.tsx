/**
 * Review MD network's "Last review" section: what the newest review record
 * (reviews/docs/<date>-md-network[-N].md, window.api.projectPages.mdReview)
 * says — date, mode, scope, base commit, map, findings counts, census, verdicts,
 * decisions, follow-up PRDs and next review due — plus `Open record` /
 * `Open validation record` (the explorer inspector, via `onOpen`) and, once the
 * next review is overdue, a `Review due` notice whose `Run drift check` launches
 * the review macro in Drift check mode against this record.
 *
 * Presentational: ToolsPane fetches the record and picks the validation path
 * (pickValidationPath); this file never calls window.api.
 */
import type { Macro, MdReviewOk, MdReviewRecord } from '../../../../../preload/api'
import type { LaunchFn } from './ToolsPane'

export const REVIEW_MD_NETWORK_MACRO_ID = 'builtin-review-md-network'
export const DRIFT_CHECK_MODE = 'Drift check'

/** One cwd's mdReview read; `loading` keeps the last result up while a refresh runs. */
export type MdReviewState =
  | { status: 'loading'; result: MdReviewOk | null }
  | { status: 'ready'; result: MdReviewOk }
  | { status: 'error'; error: string }

/** The slice of a PromptSession pickValidationPath reads. */
export interface ReviewSessionLike {
  id: string
  createdAt: string
  source?: { macroId?: string }
}

/** YYYY-MM-DD of `d` in the local timezone. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** True when `due` (YYYY-MM-DD) is before `today` (YYYY-MM-DD). */
export function isReviewDue(due: string | null | undefined, today: string): boolean {
  return !!due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today
}

/** The last (sorted) path of a non-empty list, else null. */
const lastOf = (files: readonly string[] | undefined) => (files && files.length > 0 ? files[files.length - 1] : null)

/**
 * The record's validation record: its Session line's entry in `validation`; with no Session line,
 * only when exactly one review session (source.macroId = the review macro, created on or before
 * the record date) has validation files.
 */
export function pickValidationPath(
  record: MdReviewRecord | null,
  validation: Record<string, string[]>,
  sessions: readonly ReviewSessionLike[],
): string | null {
  if (!record) return null
  if (record.session) return lastOf(validation[record.session])
  const withFiles = sessions.filter((s) => {
    if (s.source?.macroId !== REVIEW_MD_NETWORK_MACRO_ID) return false
    if (record.date) {
      const created = new Date(s.createdAt)
      if (Number.isNaN(created.getTime()) || localDate(created) > record.date) return false
    }
    return (validation[s.id]?.length ?? 0) > 0
  })
  return withFiles.length === 1 ? lastOf(validation[withFiles[0].id]) : null
}

/** The additional instructions a `Run drift check` launch sends. */
export function driftCheckInstructions(recordPath: string, command: string | null): string {
  return command
    ? `Drift-check against the last review record ${recordPath}. Run its Drift-check command: ${command}`
    : `Drift-check against the last review record ${recordPath}. It names no Drift-check command.`
}

const SECONDARY_CLASS =
  'inline-flex h-[26px] flex-none items-center rounded-md border border-rule-structural bg-bg-hi px-2.5 text-[11.5px] font-semibold text-fg-dim cursor-pointer hover:border-fg-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed'
const LABEL_CLASS = 'font-mono text-[10.5px] tracking-[.1em] text-fg-faint'

function Field({ label, children, testId, title }: { label: string; children: React.ReactNode; testId: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[2px]">
      <span className={LABEL_CLASS}>{label}</span>
      <span data-testid={testId} title={title} className="break-words text-[12.5px] text-fg">
        {children}
      </span>
    </div>
  )
}

export function MdLastReview({
  state,
  validationPath,
  macro,
  scope,
  launching,
  onLaunch,
  onOpen,
  canOpen = true,
  today = localDate(),
}: {
  state: MdReviewState | null
  validationPath: string | null
  macro: Macro
  /** The Scope a drift check falls back to when the record names none. */
  scope: string
  launching: string | null
  onLaunch: LaunchFn
  onOpen: (path: string) => void
  /** False while the explorer has no map to open into. */
  canOpen?: boolean
  /** Local YYYY-MM-DD; injectable for tests. */
  today?: string
}) {
  let body: React.ReactNode
  if (!state || (state.status === 'loading' && !state.result)) {
    body = (
      <p data-testid="md-last-review-loading" className="m-0 text-[12.5px] text-fg-faint">
        Reading the last review…
      </p>
    )
  } else if (state.status === 'error') {
    body = (
      <p data-testid="md-last-review-error" className="m-0 text-[12.5px] text-accent-dark">
        {`Could not read the review record: ${state.error}`}
      </p>
    )
  } else if (!state.result || !state.result.record || !state.result.recordPath) {
    body = (
      <p data-testid="md-last-review-none" className="m-0 text-[12.5px] text-fg-faint">
        No review record exists yet. Run review writes one when the review finishes.
      </p>
    )
  } else {
    const { record, recordPath } = state.result
    const due = isReviewDue(record.nextReviewDue, today)
    const modeInput = macro.inputs?.find((i) => i.name === 'mode')
    const canDrift = (modeInput?.options ?? []).includes(DRIFT_CHECK_MODE)
    const counts = Object.entries(record.findingsCounts)
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="md-last-review-path" className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-fg-dim">
            {recordPath}
          </span>
          <button
            type="button"
            data-testid="md-last-review-open"
            disabled={!canOpen}
            onClick={() => onOpen(recordPath)}
            className={SECONDARY_CLASS}
          >
            Open record
          </button>
          {validationPath && (
            <button
              type="button"
              data-testid="md-last-review-open-validation"
              data-path={validationPath}
              disabled={!canOpen}
              onClick={() => onOpen(validationPath)}
              className={SECONDARY_CLASS}
            >
              Open validation record
            </button>
          )}
        </div>
        {due && (
          <div
            data-testid="md-last-review-due"
            className="flex flex-wrap items-center gap-2.5 rounded-[9px] border border-honey/30 bg-honey/15 px-3 py-2 text-[12.5px] text-fg"
          >
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-honey" />
            <span className="min-w-[200px] flex-1">
              <strong className="font-semibold">Review due</strong>
              {` — the next review was due ${record.nextReviewDue}.`}
            </span>
            {canDrift && (
              <button
                type="button"
                data-testid="md-last-review-drift-check"
                disabled={launching !== null}
                onClick={() =>
                  onLaunch(macro, driftCheckInstructions(recordPath, record.driftCheckCommand), {
                    scope: record.scope ?? scope,
                    mode: DRIFT_CHECK_MODE,
                  })
                }
                className={SECONDARY_CLASS}
              >
                {launching === macro.id ? 'Starting…' : 'Run drift check'}
              </button>
            )}
          </div>
        )}
        <div className="grid gap-x-4 gap-y-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          <Field label="DATE" testId="md-last-review-date">{record.date ?? '—'}</Field>
          <Field label="MODE" testId="md-last-review-mode">{record.mode ?? '—'}</Field>
          <Field label="SCOPE" testId="md-last-review-scope">{record.scope ?? '—'}</Field>
          <Field label="BASE COMMIT" testId="md-last-review-base" title={record.baseCommit ?? undefined}>
            <span className="font-mono">{record.baseCommit ? record.baseCommit.slice(0, 8) : '—'}</span>
          </Field>
          <Field label="MAP" testId="md-last-review-map">
            <span className="font-mono">{record.map ?? '—'}</span>
          </Field>
          <Field label="NEXT REVIEW DUE" testId="md-last-review-next">{record.nextReviewNote ?? record.nextReviewDue ?? '—'}</Field>
        </div>
        <Field label="FINDINGS" testId="md-last-review-findings">
          {counts.length > 0 ? counts.map(([k, n]) => `${k} ${n}`).join(' · ') : '—'}
        </Field>
        <Field label="CENSUS" testId="md-last-review-census">{record.censusSummary ?? '—'}</Field>
        {record.verdicts.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>{`VERDICTS · ${record.verdicts.length}`}</span>
            <table data-testid="md-last-review-verdicts" className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="text-fg-faint">
                  <th className="border-b border-rule-structural py-1 pr-3 font-semibold">Doc</th>
                  <th className="border-b border-rule-structural py-1 pr-3 font-semibold">Verdict</th>
                  <th className="border-b border-rule-structural py-1 font-semibold">Owner doc</th>
                </tr>
              </thead>
              <tbody>
                {record.verdicts.map((v, i) => (
                  <tr key={`${v.doc}-${i}`} data-testid="md-last-review-verdict" className="align-top">
                    <td className="border-b border-rule-inner py-1 pr-3 font-mono text-[11.5px] text-fg break-all">{v.doc}</td>
                    <td className="border-b border-rule-inner py-1 pr-3 font-mono text-[11px] font-semibold text-fg-dim whitespace-nowrap">{v.verdict}</td>
                    <td className="border-b border-rule-inner py-1 text-fg-dim break-words">{v.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {record.decisions.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>{`DECISIONS · ${record.decisions.length}`}</span>
            <ul data-testid="md-last-review-decisions" className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[12.5px] leading-[1.5] text-fg-dim">
              {record.decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {record.followUpPrds.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className={LABEL_CLASS}>{`FOLLOW-UP PRDS · ${record.followUpPrds.length}`}</span>
            <ul data-testid="md-last-review-followups" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {record.followUpPrds.map((p) => (
                <li key={p} className="rounded-md bg-bg-hi px-2 py-0.5 font-mono text-[11px] text-fg-dim">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    )
  }
  return (
    <section data-testid="md-last-review" className="flex flex-none flex-col gap-3 rounded-[10px] bg-bg-elev px-3.5 py-3">
      <span className="font-mono text-[10.5px] tracking-[.1em] text-fg-faint">LAST REVIEW</span>
      {body}
    </section>
  )
}
