/**
 * Project Home's Pages tab (Project Home v2 DESIGN_SPEC §1, render 01-pages). List column (252px):
 * `Generate page`, `KNOWLEDGE PAGES` + count, one row per knowledge page (`<kind> · <ago>`) with
 * Rename · Delete under the selected row only. Content column: a title bar (serif title,
 * `<Kind> · <model> · <ago>`, `Regenerate…`) over the generated page in the script-free HtmlFrame.
 *
 * Generate page opens GenerateComposer on its template list; Regenerate… opens it pre-filled from
 * the entry (`pageCfgFromEntry`, §8.3). Either way the composer's prompt lines reach `onLaunch` as
 * the builtin-project-home macro's extraInstructions — Regenerate adds `Replace entry: <id>` last,
 * so the job rebuilds that entry in place (§7) — fitted under the IPC cap by `fitInstructions`.
 *
 * Presentational: entries, macro, launch state and job status come from ProjectHome through
 * ProjectPagesSection; rename / delete go through ProjectLibraryList's `v2` layout.
 */
import { useEffect, useState } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import { ProjectLibraryList, type LibraryRow } from './ProjectLibraryList'
import { GenerateComposer, type ComposerRegen } from './GenerateComposer'
import { pageCfgFromEntry, pageTemplate, type PageKind } from './composerTemplates'
import type { ProjectKnowledgeEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../preload/api'

/** `macros.dispatchJob` refuses `extraInstructions` longer than this (`src/main/ipcSchemas.cjs`). */
export const EXTRA_INSTRUCTIONS_CAP = 4000

/** `pagePromptLines` opens with Page, Audience, Length and Read from; any line after them is the Focus text. */
const PAGE_FIXED_LINES = 4

const GENERATE_CLASS =
  'flex h-[38px] flex-none items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-semibold text-bg-hi cursor-pointer enabled:hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

const REGENERATE_CLASS =
  'inline-flex h-8 flex-none items-center gap-[7px] whitespace-nowrap rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12.5px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

/** `text` cut to at most `max` UTF-16 units, never splitting a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

/**
 * `fixed` lines, then `focus`, then `tail`, joined with `\n` in at most `cap` characters. Focus is
 * cut first; when the other lines alone already fill the cap (only a very long custom topic can),
 * Focus is dropped and the longest fixed line is cut. `tail` — the `Replace entry` line — is never cut.
 */
export function fitInstructions(
  fixed: readonly string[],
  focus: string,
  tail: readonly string[] = [],
  cap = EXTRA_INSTRUCTIONS_CAP,
): string {
  const join = (head: readonly string[], f: string) => [...head, ...(f ? [f] : []), ...tail].join('\n')
  const bare = join(fixed, '')
  if (bare.length >= cap) {
    const longest = fixed.reduce((best, line, i) => (line.length > fixed[best].length ? i : best), 0)
    const over = bare.length - cap
    return join(
      fixed.map((line, i) => (i === longest ? cutText(line, line.length - over) : line)),
      '',
    )
  }
  return join(fixed, cutText(focus, cap - bare.length - 1).trimEnd())
}

/** Overview / How it works / FAQ / Custom topic — the composer template the entry id maps to (§8.3). */
function pageKind(id: string): PageKind {
  return pageTemplate(pageCfgFromEntry(id, null).tplId).page
}

/** `<n> ago` from the recorded `createdAt`, else the file's mtime. */
export function createdLabel(entry: { mtimeMs: number; meta: { createdAt: string } | null }): string {
  const t = entry.meta ? Date.parse(entry.meta.createdAt) : NaN
  return formatAgo(Number.isFinite(t) ? t : entry.mtimeMs, Date.now())
}

/** A library macro's background job, as one status line (+ Open session when it has an Epic). */
export function JobStatusLine({ status, onOpenSession }: { status: MacroJobStatus; onOpenSession?: (epicId: string) => void }) {
  const since = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? formatAgo(Date.parse(iso), Date.now()) : 'just now')
  let text: string
  if (status.state === 'queued') text = 'Queued'
  else if (status.state === 'running') text = `Building… started ${since(status.startedAt)}`
  else if (status.state === 'done') text = `Done ${since(status.finishedAt)}`
  else text = `Failed: ${status.reason ?? status.status}`
  const failed = status.state === 'failed'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        data-testid="project-home-job-status"
        data-state={status.state}
        role={failed ? 'alert' : undefined}
        className={`font-mono text-[10.5px] ${failed ? 'text-red-400' : 'text-fg-faint'}`}
      >
        {text}
      </span>
      {status.epicId && onOpenSession && (
        <button
          type="button"
          data-testid="project-home-job-session"
          onClick={() => onOpenSession(status.epicId!)}
          className="text-[10.5px] font-semibold text-accent underline cursor-pointer"
        >
          Open session
        </button>
      )}
    </span>
  )
}

function KnowledgeFrame({ entry }: { entry: ProjectKnowledgeEntry }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setHtml(null)
    window.api.config
      .readText(entry.path)
      .then((res) => {
        if (!cancelled) setHtml(res.exists ? res.text : '')
      })
      .catch(() => {
        if (!cancelled) setHtml('')
      })
    return () => {
      cancelled = true
    }
  }, [entry.path, entry.mtimeMs])
  if (html === null) return null
  return <HtmlFrame title={entry.meta?.title || entry.id} html={html} />
}

function pageRow(e: ProjectKnowledgeEntry): LibraryRow {
  return {
    id: e.id,
    title: e.meta?.title,
    content: (
      <span className="flex min-w-0 flex-col gap-[5px]">
        {e.meta ? (
          <span data-col="title" className="truncate text-[13.5px] font-semibold">
            {e.meta.title}
          </span>
        ) : (
          <span data-col="title" className="break-words text-xs text-red-400">
            {e.id}: {e.error ?? 'unreadable meta'}
          </span>
        )}
        <span data-col="meta" className="font-mono text-[10.5px] text-fg-faint">
          {`${pageKind(e.id).toLowerCase()} · ${createdLabel(e)}`}
        </span>
      </span>
    ),
  }
}

export interface PagesPaneProps {
  cwd?: string | null
  /** Knowledge pages, newest first (ProjectHome's `useProjectPagesOutput`). */
  entries: ProjectKnowledgeEntry[]
  /** `builtin-project-home`; without it Generate page and Regenerate… stay disabled. */
  macro: Macro | undefined
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
  /** The page macro's job. Queued / running disables Generate (the building UI is PRD ph2-building-state). */
  jobStatus?: MacroJobStatus
  onOpenSession?: (epicId: string) => void
  /** Controlled selection — ProjectPagesSection keeps it across key-button switches. Without `onSelect` the pane keeps its own. */
  selectedId?: string | null
  onSelect?: (id: string) => void
}

export function PagesPane({
  cwd,
  entries,
  macro,
  launching,
  onLaunch,
  jobStatus,
  onOpenSession,
  selectedId,
  onSelect,
}: PagesPaneProps) {
  const [ownId, setOwnId] = useState<string | null>(null)
  // Open composer: `{}` = Generate page, `{ regen }` = Regenerate… (mounted per open — it reads its props once).
  const [composer, setComposer] = useState<{ regen?: ComposerRegen } | null>(null)
  const select = onSelect ?? setOwnId
  const pickedId = onSelect ? (selectedId ?? null) : ownId
  // Newest (first) entry by default; a pick survives list refreshes while its entry still exists.
  const selected = entries.find((e) => e.id === pickedId) ?? entries[0] ?? null
  const building = jobStatus?.state === 'queued' || jobStatus?.state === 'running'
  const busy = !macro || launching !== null || building

  const launch = (lines: string[], replaceEntryId?: string) => {
    setComposer(null)
    if (!macro) return
    const tail = replaceEntryId ? [`Replace entry: ${replaceEntryId}`] : []
    onLaunch(macro, fitInstructions(lines.slice(0, PAGE_FIXED_LINES), lines.slice(PAGE_FIXED_LINES).join('\n'), tail))
  }

  const regenerate = (entry: ProjectKnowledgeEntry) => {
    const { tplId, cfg } = pageCfgFromEntry(entry.id, entry.meta)
    setComposer({ regen: { entryId: entry.id, title: entry.meta?.title || entry.id, tplId, cfg } })
  }

  const composerNode = composer && (
    <GenerateComposer kind="page" regen={composer.regen} onClose={() => setComposer(null)} onGenerate={launch} />
  )
  const statusLine = jobStatus && <JobStatusLine status={jobStatus} onOpenSession={onOpenSession} />
  const generateButton = (fullWidth: boolean) => (
    <button
      type="button"
      data-testid="project-home-generate"
      data-kind="page"
      disabled={busy}
      title={macro ? undefined : 'The built-in Project Home macro is not available for this project'}
      onClick={() => setComposer({})}
      className={`${GENERATE_CLASS} ${fullWidth ? 'w-full' : 'px-4'}`}
    >
      <AlmanacIcon name="plus" size={14} stroke={2} />
      {macro && launching === macro.id ? 'Starting…' : 'Generate page'}
    </button>
  )

  const sub = selected
    ? [pageKind(selected.id), selected.meta?.model, createdLabel(selected)].filter(Boolean).join(' · ')
    : ''

  // Both branches share one composer slot, so the first page landing while the composer is open keeps its form.
  return (
    <>
      {selected ? (
        <div
          data-testid="project-home-library"
          className="grid min-h-0 flex-1 gap-[20px]"
          style={{ gridTemplateColumns: '252px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)' }}
        >
          <div className="flex min-h-0 flex-col gap-3">
            {generateButton(true)}
            {statusLine && <div className="flex-none px-0.5">{statusLine}</div>}
            <div
              data-testid="project-home-pages-header"
              className="flex flex-none items-baseline justify-between px-0.5 pt-0.5 font-mono text-[10.5px] text-fg-faint"
            >
              <span className="tracking-[.1em]">KNOWLEDGE PAGES</span>
              <span data-testid="project-home-pages-count">{entries.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-px">
              <ProjectLibraryList
                layout="v2"
                label="Knowledge pages"
                itemTestId="knowledge-page-item"
                cwd={cwd}
                kind="knowledge"
                rows={entries.map(pageRow)}
                selectedId={selected.id}
                onSelect={select}
              />
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <div className="flex flex-none flex-wrap items-center gap-3">
              <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
                <h2
                  data-testid="project-home-page-title"
                  className="m-0 break-words font-serif text-[22px] font-semibold leading-[1.15] text-fg"
                >
                  {selected.meta?.title || selected.id}
                </h2>
                <span data-testid="project-home-page-sub" className="font-mono text-[11px] text-fg-faint">
                  {sub}
                </span>
              </div>
              <button
                type="button"
                data-testid="project-home-regenerate"
                disabled={busy}
                onClick={() => regenerate(selected)}
                className={REGENERATE_CLASS}
              >
                <AlmanacIcon name="reload" size={14} />
                Regenerate…
              </button>
            </div>
            <div
              data-testid="project-home-content"
              className="min-h-0 flex-1 overflow-auto rounded-xl border border-rule-structural bg-bg-hi"
            >
              <KnowledgeFrame entry={selected} />
            </div>
          </div>
        </div>
      ) : (
        <div data-testid="knowledge-page-empty" className="flex min-h-0 flex-1 justify-center overflow-auto py-16">
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs text-fg-faint">No knowledge pages yet.</span>
            {generateButton(false)}
            {statusLine}
          </div>
        </div>
      )}
      {composerNode}
    </>
  )
}
