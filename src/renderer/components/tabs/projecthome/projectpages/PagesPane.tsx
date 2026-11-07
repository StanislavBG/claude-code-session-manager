/**
 * Project Home's Pages tab (Project Home v2 DESIGN_SPEC §1, render 01-pages). List column (252px):
 * `Generate page`, `KNOWLEDGE PAGES` + count, one row per knowledge page (`<kind> · <ago>`) with
 * Rename · Delete under the selected row only. Content column: a title bar (serif title,
 * `<Kind> · <model> · <ago>`, `Regenerate…`) over the generated page in the script-free HtmlFrame.
 *
 * Generate page opens GenerateComposer on its template list; Regenerate… opens it pre-filled from
 * the entry (`pageCfgFromEntry`, §8.3). Either way the composer's prompt lines reach `onLaunch` as
 * the builtin-project-home macro's extraInstructions — Regenerate adds `Replace entry: <id>` last,
 * so the job rebuilds that entry in place (§7) — fitted under the IPC cap by `fitInstructions` —
 * and `onLaunched` hands ProjectHome the launch (title, sent lines, entry replaced) to keep.
 *
 * Building (§4): while the page job is queued / running, a building row sits at the top of the list
 * (or the regenerated entry's own row turns building) and is selected after a launch or when nothing
 * else is picked; selected, it shows BuildingPanel with Open session in the title bar. A failed job
 * shows its reason in the building row's place until the next launch.
 *
 * Empty (§4): no pages and nothing building shows LibraryEmptyState — one starter card per page
 * template. Its Generate launches that template's defaults (`pagePromptLines` of `pageDefaults`)
 * straight through `launch`; Customize, and Custom topic's `Name a topic`, open the composer on the
 * template. A failed job's reason shows above the cards; the TIP link calls `onGoTools`.
 *
 * Presentational: entries, macro, launch state, job status and the last launch come from ProjectHome
 * through ProjectPagesSection; rename / delete go through ProjectLibraryList's `v2` layout.
 */
import { useEffect, useState } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import { ProjectLibraryList, type LibraryRow } from './ProjectLibraryList'
import { GenerateComposer, type ComposerRegen } from './GenerateComposer'
import { LibraryEmptyState } from './LibraryEmptyState'
import { pageCfgFromEntry, pageDefaults, pagePromptLines, pageTemplate, type PageKind } from './composerTemplates'
import {
  BUILDING_ROW_ID,
  BuildFailedRow,
  BuildingMeta,
  BuildingPanel,
  IndeterminateBar,
  JobStatusLine,
  failureShown,
  isBuilding,
  sentValue,
  type BuildLaunch,
} from './BuildingPanel'
import type { ProjectKnowledgeEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../preload/api'

/** `macros.dispatchJob` refuses `extraInstructions` longer than this (`src/main/ipcSchemas.cjs`). */
export const EXTRA_INSTRUCTIONS_CAP = 4000

/** `pagePromptLines` opens with Page, Audience, Length and Read from; any line after them is the Focus text. */
const PAGE_FIXED_LINES = 4

const NO_MACRO_TITLE = 'The built-in Project Home macro is not available for this project'

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

/** A new page's building title (prototype `create`): the template's page, or a custom topic up to its first `:`. */
function pageBuildTitle(lines: readonly string[]): string {
  const page = sentValue(lines, 'Page') ?? ''
  const custom = 'Custom topic: '
  if (!page.startsWith(custom)) return page || 'New page'
  return page.slice(custom.length).split(':')[0].trim() || 'Untitled topic'
}

/** A building page's title-bar sub (prototype): `<kind> · <audience> · <length>` from the sent lines. */
function pageBuildSub(lines: readonly string[] | undefined): string {
  const page = sentValue(lines, 'Page')
  const kind = page?.startsWith('Custom topic') ? 'Custom topic' : page
  return [kind, sentValue(lines, 'Audience')?.toLowerCase(), sentValue(lines, 'Length')?.toLowerCase()]
    .filter(Boolean)
    .join(' · ')
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

/** A building row's content (§1): title, accent `Queued` / `Building… started <ago>`, a 3px bar. */
function PageBuildingRow({ title, status }: { title: string; status: MacroJobStatus }) {
  return (
    <span data-testid="project-home-building-row" data-state={status.state} className="flex min-w-0 flex-col gap-[5px]">
      <span data-col="title" className="truncate text-[13.5px] font-semibold">
        {title}
      </span>
      <BuildingMeta status={status} />
      <IndeterminateBar size="row" />
    </span>
  )
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
  /** The page macro's job. Queued / running disables Generate and shows the building row; failed shows its reason. */
  jobStatus?: MacroJobStatus
  onOpenSession?: (epicId: string) => void
  /** Controlled selection — ProjectPagesSection keeps it across key-button switches. Without `onSelect` the pane keeps its own. */
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** This window's last launch of the page macro (ProjectHome); absent after an app reload. */
  lastLaunch?: BuildLaunch
  /** Reports each launch so ProjectHome can keep it as the macro's `lastLaunch`. */
  onLaunched?: (macroId: string, launch: BuildLaunch) => void
  /** Switches Project Home to Tools — the empty state's `Review MD network` link. */
  onGoTools?: () => void
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
  lastLaunch,
  onLaunched,
  onGoTools,
}: PagesPaneProps) {
  const [ownId, setOwnId] = useState<string | null>(null)
  // Open composer: `{}` = Generate page, `{ tplId }` = an empty-state card, `{ regen }` = Regenerate…
  // (mounted per open — it reads its props once).
  const [composer, setComposer] = useState<{ regen?: ComposerRegen; tplId?: string } | null>(null)
  const select = onSelect ?? setOwnId
  const pickedId = onSelect ? (selectedId ?? null) : ownId
  const build = isBuilding(jobStatus) ? jobStatus : undefined
  // A Regenerate… from this window rebuilds its entry in place; any other build gets a new row on top.
  const replaceId = lastLaunch?.replaceEntryId
  const replacingId = build && replaceId && entries.some((e) => e.id === replaceId) ? replaceId : null
  const buildRowId = build ? (replacingId ?? BUILDING_ROW_ID) : null
  // A pick survives list refreshes while its row still exists; else the building row, else the newest (first) entry.
  const shownId =
    pickedId !== null && (pickedId === buildRowId || entries.some((e) => e.id === pickedId))
      ? pickedId
      : (buildRowId ?? entries[0]?.id ?? null)
  const buildingShown = build !== undefined && shownId === buildRowId
  const selected = buildingShown ? null : (entries.find((e) => e.id === shownId) ?? null)
  // After an app reload there is no launch from this window: the macro label stands in.
  const buildTitle = lastLaunch?.title ?? macro?.label ?? 'New page'
  const failed = failureShown(jobStatus, lastLaunch) ? jobStatus : undefined
  const busy = !macro || launching !== null || build !== undefined

  const launch = (lines: string[], replaceEntryId?: string) => {
    setComposer(null)
    if (!macro) return
    const tail = replaceEntryId ? [`Replace entry: ${replaceEntryId}`] : []
    const extra = fitInstructions(lines.slice(0, PAGE_FIXED_LINES), lines.slice(PAGE_FIXED_LINES).join('\n'), tail)
    const entry = replaceEntryId ? entries.find((e) => e.id === replaceEntryId) : undefined
    onLaunched?.(macro.id, {
      title: entry ? entry.meta?.title || entry.id : pageBuildTitle(lines),
      lines: extra.split('\n'),
      ...(replaceEntryId ? { replaceEntryId } : {}),
      at: Date.now(),
    })
    // The build shows in this row once its job is queued.
    select(replaceEntryId ?? BUILDING_ROW_ID)
    onLaunch(macro, extra)
  }

  const regenerate = (entry: ProjectKnowledgeEntry) => {
    const { tplId, cfg } = pageCfgFromEntry(entry.id, entry.meta)
    setComposer({ regen: { entryId: entry.id, title: entry.meta?.title || entry.id, tplId, cfg } })
  }

  const composerNode = composer && (
    <GenerateComposer
      kind="page"
      regen={composer.regen}
      initialTplId={composer.tplId}
      onClose={() => setComposer(null)}
      onGenerate={launch}
    />
  )
  const generateButton = (
    <button
      type="button"
      data-testid="project-home-generate"
      data-kind="page"
      disabled={busy}
      title={macro ? undefined : NO_MACRO_TITLE}
      onClick={() => setComposer({})}
      className={`${GENERATE_CLASS} w-full`}
    >
      <AlmanacIcon name="plus" size={14} stroke={2} />
      {macro && launching === macro.id ? 'Starting…' : 'Generate page'}
    </button>
  )

  const rows: LibraryRow[] = entries.map((e) =>
    build && e.id === replacingId
      ? { id: e.id, title: e.meta?.title, content: <PageBuildingRow title={buildTitle} status={build} /> }
      : pageRow(e),
  )
  if (build && !replacingId) rows.unshift({ id: BUILDING_ROW_ID, content: <PageBuildingRow title={buildTitle} status={build} /> })

  const title = buildingShown ? buildTitle : selected ? selected.meta?.title || selected.id : ''
  const sub = buildingShown
    ? pageBuildSub(lastLaunch?.lines)
    : selected
      ? [pageKind(selected.id), selected.meta?.model, createdLabel(selected)].filter(Boolean).join(' · ')
      : ''
  const epicId = build?.epicId ?? null

  // Both branches share one composer slot, so the first page landing while the composer is open keeps its form.
  return (
    <>
      {shownId !== null ? (
        <div
          data-testid="project-home-library"
          className="grid min-h-0 flex-1 gap-[20px]"
          style={{ gridTemplateColumns: '252px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)' }}
        >
          <div className="flex min-h-0 flex-col gap-3">
            {generateButton}
            <div
              data-testid="project-home-pages-header"
              className="flex flex-none items-baseline justify-between px-0.5 pt-0.5 font-mono text-[10.5px] text-fg-faint"
            >
              <span className="tracking-[.1em]">KNOWLEDGE PAGES</span>
              <span data-testid="project-home-pages-count">{rows.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-px">
              {failed && <BuildFailedRow status={failed} onOpenSession={onOpenSession} />}
              {/* No cwd while the building row is shown: Rename · Delete sit under a selected, non-building row only (§1). */}
              <ProjectLibraryList
                layout="v2"
                label="Knowledge pages"
                itemTestId="knowledge-page-item"
                cwd={buildingShown ? null : cwd}
                kind="knowledge"
                rows={rows}
                selectedId={shownId}
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
                  {title}
                </h2>
                <span data-testid="project-home-page-sub" className="font-mono text-[11px] text-fg-faint">
                  {sub}
                </span>
              </div>
              {buildingShown ? (
                <button
                  type="button"
                  data-testid="project-home-open-session"
                  disabled={!epicId || !onOpenSession}
                  onClick={() => {
                    if (epicId) onOpenSession?.(epicId)
                  }}
                  className={REGENERATE_CLASS}
                >
                  Open session
                </button>
              ) : (
                selected && (
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
                )
              )}
            </div>
            <div
              data-testid="project-home-content"
              className={`min-h-0 flex-1 overflow-auto rounded-xl border border-rule-structural ${buildingShown ? 'bg-bg-elev' : 'bg-bg-hi'}`}
            >
              {build && buildingShown ? (
                <BuildingPanel
                  kind="page"
                  title={buildTitle}
                  lines={lastLaunch?.lines}
                  agentName={macro?.agentName}
                  jobStatus={build}
                  onOpenSession={onOpenSession}
                />
              ) : (
                selected && <KnowledgeFrame entry={selected} />
              )}
            </div>
          </div>
        </div>
      ) : (
        <LibraryEmptyState
          kind="page"
          onQuick={(tplId) => launch(pagePromptLines(tplId, pageDefaults(tplId)))}
          onCustomize={(tplId) => setComposer({ tplId })}
          onGoTools={onGoTools}
          disabled={busy}
          disabledTitle={macro ? undefined : NO_MACRO_TITLE}
          starting={macro !== undefined && launching === macro.id}
          notice={failed && <JobStatusLine status={failed} onOpenSession={onOpenSession} />}
        />
      )}
      {composerNode}
    </>
  )
}
