/**
 * Review MD network's one-line review history: `Last review <date> · <mode> · <n> runs` from the
 * newest review record (reviews/docs/<date>-md-network[-N].md, window.api.projectPages.mdReview)
 * and this project's review runs, with `Open record` / `Open validation record` (the explorer
 * inspector, via `onOpen`), `Open run` (the newest review session, via `onOpenRun`) and, once the
 * next review is overdue, `Run drift check` — the review macro in Drift check mode against this
 * record. With no record: `No review yet — Run review starts one.` The record itself holds the
 * detail (scope, verdicts, decisions…); Open record shows it, so the pane leads with the fix list.
 *
 * Presentational: ToolsPane fetches the record, derives the runs and picks the validation path
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

const runsLabel = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`

export function MdLastReview({
  state,
  validationPath,
  macro,
  scope,
  launching,
  onLaunch,
  onOpen,
  canOpen = true,
  runCount = 0,
  newestRunId = null,
  onOpenRun,
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
  /** This project's Review MD network sessions (ToolsPane's runs list). */
  runCount?: number
  /** The newest of those sessions, for `Open run`. */
  newestRunId?: string | null
  onOpenRun?: (epicId: string) => void
  /** Local YYYY-MM-DD; injectable for tests. */
  today?: string
}) {
  const openRun = newestRunId ? (
    <button
      type="button"
      data-testid="md-last-review-open-run"
      data-epic-id={newestRunId}
      disabled={!onOpenRun}
      onClick={() => onOpenRun?.(newestRunId)}
      className={SECONDARY_CLASS}
    >
      Open run
    </button>
  ) : null
  let body: React.ReactNode
  if (!state || (state.status === 'loading' && !state.result)) {
    body = (
      <span data-testid="md-last-review-loading" className="text-fg-faint">
        Reading the last review…
      </span>
    )
  } else if (state.status === 'error') {
    body = (
      <span data-testid="md-last-review-error" className="text-accent-dark">
        {`Could not read the review record: ${state.error}`}
      </span>
    )
  } else if (!state.result || !state.result.record || !state.result.recordPath) {
    body = (
      <>
        <span data-testid="md-last-review-none" className="min-w-0 flex-1 text-fg-faint">
          No review yet — Run review starts one.
        </span>
        {openRun}
      </>
    )
  } else {
    const { record, recordPath } = state.result
    const due = isReviewDue(record.nextReviewDue, today)
    const modeInput = macro.inputs?.find((i) => i.name === 'mode')
    const canDrift = (modeInput?.options ?? []).includes(DRIFT_CHECK_MODE)
    body = (
      <>
        <span
          data-testid="md-last-review-line"
          data-path={recordPath}
          title={recordPath}
          className="min-w-0 flex-1 truncate text-fg"
        >
          {`Last review ${record.date ?? '—'} · ${record.modeKind ?? record.mode ?? '—'} · ${runsLabel(runCount)}`}
        </span>
        {due && (
          <span
            data-testid="md-last-review-due"
            title={`The next review was due ${record.nextReviewDue}.`}
            className="inline-flex flex-none items-center gap-1.5 text-[11.5px] font-semibold text-fg"
          >
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-honey" />
            Review due
          </span>
        )}
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
        {openRun}
        {due && canDrift && (
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
      </>
    )
  }
  return (
    <section
      data-testid="md-last-review"
      aria-label="Last review"
      className="flex flex-none flex-wrap items-center gap-2 rounded-[10px] bg-bg-elev px-3.5 py-2 text-[12.5px]"
    >
      {body}
    </section>
  )
}
