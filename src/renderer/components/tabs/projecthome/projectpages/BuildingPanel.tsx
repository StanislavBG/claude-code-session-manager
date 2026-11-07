/**
 * Project Home's build state (Project Home v2 DESIGN_SPEC §1 "List rows" + §4 "Building", render
 * 04-video-building) — what PagesPane and VideosPane share while a library macro's background job
 * (`builtin-project-home` / `builtin-demo-video`) is queued or running:
 *
 * - `BuildingPanel` — the content area of the selected building row: pulse + `QUEUED`|`BUILDING`,
 *   the serif title, the builder explanation, a 4px indeterminate bar, the `Sent to the builder`
 *   lines (only when this window launched the build) and `Waiting to start`|`Started <ago>` ·
 *   `Open session`.
 * - `BuildingMeta` + `IndeterminateBar` — a building row's accent `Queued` /
 *   `Building… started <ago>` and its 3px bar.
 * - `BuildFailedRow` / `JobStatusLine` — a failed job's reason with Open session, in the building
 *   row's place until the next launch (`failureShown`).
 * - `useJobSettled` — ProjectHome's "this job just finished" signal for the `“<title>” is ready` toast.
 *
 * `BuildLaunch` is what ProjectHome keeps of this window's last launch per macro. An app reload
 * loses it, so the panes fall back to the macro label and leave the lines box out.
 */
import { useEffect, useRef } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import type { MacroJobStatus } from '../../../../../preload/api'

/** Selection id of the row a new entry builds in. Entry ids are `[a-z0-9-]`, so none can take it. */
export const BUILDING_ROW_ID = ':building'

/** This window's last Generate / Regenerate… press for one library macro (ProjectHome keeps it per macro). */
export interface BuildLaunch {
  /** Building row + panel title: the template name, custom topic or video target — or the rebuilt entry's title. */
  title: string
  /** The extraInstructions lines sent to the builder. */
  lines: string[]
  /** Set by Regenerate…: the entry rebuilt in place, whose own row turns building. */
  replaceEntryId?: string
  /** `Date.now()` at the press; a failure that ended before it no longer shows. */
  at: number
}

/** Whether the macro's job is queued or running — what disables Generate and shows the building row. */
export function isBuilding(status: MacroJobStatus | undefined): boolean {
  return status?.state === 'queued' || status?.state === 'running'
}

/** `<ago>` since an ISO time; `just now` when it is missing or unreadable. */
function since(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? formatAgo(t, Date.now()) : 'just now'
}

/** A job as one line: `Queued`, `Building… started <ago>`, `Done <ago>` or `Failed: <reason>`. */
export function jobStateText(status: MacroJobStatus): string {
  switch (status.state) {
    case 'queued':
      return 'Queued'
    case 'running':
      return `Building… started ${since(status.startedAt)}`
    case 'done':
      return `Done ${since(status.finishedAt)}`
    case 'failed':
      return `Failed: ${status.reason ?? status.status}`
  }
}

/**
 * Whether a failed job still shows: until this window launches again after it ended. A failure
 * with no recorded time keeps showing until the next job replaces it.
 */
export function failureShown(status: MacroJobStatus | undefined, launch: BuildLaunch | undefined): boolean {
  if (status?.state !== 'failed') return false
  const ended = Date.parse(status.finishedAt ?? status.startedAt ?? '')
  return !(launch && Number.isFinite(ended) && launch.at > ended)
}

/** The text after `<key>: ` on the first sent line that starts with it, else null. */
export function sentValue(lines: readonly string[] | undefined, key: string): string | null {
  const prefix = `${key}: `
  const line = lines?.find((l) => l.startsWith(prefix))
  return line === undefined ? null : line.slice(prefix.length)
}

/** A library macro's background job as one status line, with Open session when it has an Epic. */
export function JobStatusLine({ status, onOpenSession }: { status: MacroJobStatus; onOpenSession?: (epicId: string) => void }) {
  const failed = status.state === 'failed'
  const epicId = status.epicId
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        data-testid="project-home-job-status"
        data-state={status.state}
        role={failed ? 'alert' : undefined}
        className={`font-mono text-[10.5px] ${failed ? 'text-red-400' : 'text-fg-faint'}`}
      >
        {jobStateText(status)}
      </span>
      {epicId && onOpenSession && (
        <button
          type="button"
          data-testid="project-home-job-session"
          onClick={() => onOpenSession(epicId)}
          className="text-[10.5px] font-semibold text-accent underline cursor-pointer"
        >
          Open session
        </button>
      )}
    </span>
  )
}

/** A failed job in the building row's place at the top of the list (DESIGN_SPEC §4). */
export function BuildFailedRow({ status, onOpenSession }: { status: MacroJobStatus; onOpenSession?: (epicId: string) => void }) {
  return (
    <div data-testid="project-home-build-failed" className="flex-none rounded-[9px] border border-rule-structural px-3 py-2.5">
      <JobStatusLine status={status} onOpenSession={onOpenSession} />
    </div>
  )
}

/**
 * The design's indeterminate bar: 3px under a building row, 4px in the panel. The fill slides on the
 * `sm-indeterminate` keyframe (styles.css) and holds still under reduced motion.
 */
export function IndeterminateBar({ size }: { size: 'row' | 'panel' }) {
  const panel = size === 'panel'
  return (
    <span
      data-testid="project-home-building-bar"
      role={panel ? 'progressbar' : undefined}
      aria-label={panel ? 'Building' : undefined}
      aria-hidden={panel ? undefined : true}
      className={`relative block w-full flex-none overflow-hidden rounded-full bg-rule-inner ${panel ? 'h-[4px]' : 'h-[3px]'}`}
    >
      <span className="absolute inset-y-0 left-0 w-[38%] rounded-full bg-accent animate-[sm-indeterminate_1.4s_ease-in-out_infinite] motion-reduce:animate-none" />
    </span>
  )
}

/** A building row's meta in accent: `Queued` or `Building… started <ago>`. */
export function BuildingMeta({ status }: { status: MacroJobStatus }) {
  return (
    <span data-col="meta" className="font-mono text-[10.5px] text-accent-dark">
      {jobStateText(status)}
    </span>
  )
}

/** Builder named in the explanation when the macro gives none. */
const DEFAULT_AGENT = { page: 'project-home-builder', video: 'demo-video-builder' } as const

/** DESIGN_SPEC §4's builder explanation; a video's length word comes from its sent `Video length`. */
function explanation(kind: 'page' | 'video', agent: string, lines: readonly string[] | undefined): string {
  if (kind === 'page') {
    return `The ${agent} agent is reading the project. It saves the page with one project_page_write call, and it shows up here when it's done — you can keep working meanwhile.`
  }
  const len = Number(sentValue(lines, 'Video length'))
  const what = !Number.isFinite(len) || len <= 0 ? 'an' : len > 30 ? 'a one-minute' : 'a 30-second'
  return `The ${agent} agent is writing ${what} animation. Before it’s saved it is checked for length, loudness and any network access.`
}

export interface BuildingPanelProps {
  kind: 'page' | 'video'
  title: string
  /** The lines this window sent the builder. Unknown after an app reload — then the box is left out. */
  lines?: readonly string[]
  /** The macro's agent, named in the explanation; defaults to the built-in builder. */
  agentName?: string
  /** The macro's queued or running job. */
  jobStatus: MacroJobStatus
  onOpenSession?: (epicId: string) => void
}

/**
 * The selected building row's content (DESIGN_SPEC §4). A page fills the pane's content frame,
 * centred; a video sits in a dashed 16:9 box where the player goes.
 */
export function BuildingPanel({ kind, title, lines, agentName, jobStatus, onOpenSession }: BuildingPanelProps) {
  const queued = jobStatus.state === 'queued'
  const video = kind === 'video'
  const epicId = jobStatus.epicId
  return (
    <div
      data-testid="project-home-building"
      data-state={queued ? 'queued' : 'running'}
      className={
        video
          ? 'flex aspect-video flex-none items-center justify-center rounded-xl border border-dashed border-fg-faint bg-bg-elev p-6'
          : 'flex min-h-full items-center justify-center px-6 py-10'
      }
    >
      <div className={`flex w-full max-w-[440px] flex-col ${video ? 'gap-3.5' : 'gap-4'}`}>
        <span
          data-testid="project-home-building-state"
          className="flex items-center gap-2 font-mono text-[11px] tracking-[.12em] text-accent-dark"
        >
          <span
            data-testid="project-home-building-pulse"
            aria-hidden="true"
            className="h-[7px] w-[7px] flex-none rounded-full bg-accent animate-pulse motion-reduce:animate-none"
          />
          {queued ? 'QUEUED' : 'BUILDING'}
        </span>
        <span
          data-testid="project-home-building-title"
          className="break-words font-serif text-[28px] font-semibold leading-[1.12] text-fg"
        >
          {title}
        </span>
        <p data-testid="project-home-building-text" className="m-0 text-[13.5px] leading-[1.6] text-fg-dim">
          {explanation(kind, agentName || DEFAULT_AGENT[kind], lines)}
        </p>
        <IndeterminateBar size="panel" />
        {lines && lines.length > 0 && (
          <div
            data-testid="project-home-building-lines"
            className="flex flex-col gap-1.5 rounded-[10px] border border-rule-structural bg-bg px-3.5 py-3"
          >
            <span className="text-[11px] text-fg-faint">Sent to the builder</span>
            {lines.map((line, i) => (
              <span
                key={i}
                data-testid="project-home-building-line"
                className="break-words font-mono text-[11.5px] leading-[1.5] text-fg"
              >
                {line}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-faint">
          <span data-testid="project-home-building-elapsed">
            {queued ? 'Waiting to start' : `Started ${since(jobStatus.startedAt)}`}
          </span>
          {epicId && onOpenSession && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                data-testid="project-home-building-session"
                onClick={() => onOpenSession(epicId)}
                className="font-semibold text-accent-dark hover:underline cursor-pointer"
              >
                Open session
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Calls `onSettled` once for each job a newer `jobStatus` snapshot of the same project shows
 * finished — the same job (slug) seen queued or running before and done or failed now. A first
 * sighting, an unchanged snapshot and a project switch never fire.
 */
export function useJobSettled(
  cwd: string | null,
  jobStatus: Record<string, MacroJobStatus>,
  onSettled: (status: MacroJobStatus) => void,
): void {
  const seen = useRef<{ cwd: string | null; jobs: Record<string, MacroJobStatus> }>({ cwd, jobs: {} })
  useEffect(() => {
    const prev = seen.current.cwd === cwd ? seen.current.jobs : {}
    seen.current = { cwd, jobs: jobStatus }
    for (const status of Object.values(jobStatus)) {
      const before = prev[status.macroId]
      if (!before || before.slug !== status.slug || !isBuilding(before)) continue
      if (status.state === 'done' || status.state === 'failed') onSettled(status)
    }
  }, [cwd, jobStatus, onSettled])
}
