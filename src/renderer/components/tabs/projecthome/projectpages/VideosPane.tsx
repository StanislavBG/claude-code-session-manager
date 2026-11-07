/**
 * Project Home's Videos tab (Project Home v2 DESIGN_SPEC §1 + §5, render 03-videos) — the Pages
 * layout, so the list sits in the same place on both tabs. List column (252px): `Generate video`,
 * `VIDEOS` + count, one row per video — an 86px 16:9 thumbnail in the entry's style colours (title,
 * `m:ss` duration), the title, `<kind> · <len>s · <ago>` and `LUFS <x> · grade <y>` — with
 * Rename · Delete under the selected row only. Content column (scrolls on its own): a title bar
 * (serif title, `<kind> · <len>s · <style> · <ago>`, `Regenerate…`), the real VideoPlayer, then the
 * SOURCES and QUALITY REPORT cards from the entry's meta. No SCENES chips (§8.2).
 *
 * Generate video opens GenerateComposer on its video templates; Regenerate… opens it pre-filled from
 * the entry (`videoCfgFromEntry`, §8.3 — an entry with unreadable meta starts from the Project demo
 * defaults). Either way the composer's prompt lines reach `onLaunch` as the builtin-demo-video
 * macro's extraInstructions — Regenerate adds `Replace entry: <id>` last, so the job rebuilds that
 * entry in place (§7) — fitted under the IPC cap by PagesPane's `fitInstructions` — and `onLaunched`
 * hands ProjectHome the launch (title, sent lines, entry replaced) to keep.
 *
 * Building (§4, render 04-video-building): while the video job is queued / running, a building row
 * (`· · ·` thumbnail) sits at the top of the list (or the regenerated video's own row turns
 * building) and is selected after a launch or when nothing else is picked; selected, BuildingPanel
 * takes the player's place and the title bar offers Open session. A failed job shows its reason in
 * the building row's place until the next launch.
 *
 * Presentational: entries, macro, launch state, job status and the last launch come from ProjectHome
 * through ProjectPagesSection; rename / delete go through ProjectLibraryList's `v2` layout.
 */
import { useState } from 'react'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { VideoPlayer } from './VideoPlayer'
import { createdLabel, fitInstructions } from './PagesPane'
import { ProjectLibraryList, type LibraryRow } from './ProjectLibraryList'
import { GenerateComposer, type ComposerRegen } from './GenerateComposer'
import { VIDEO_STYLES, VIDEO_TEMPLATES, videoCfgFromEntry, videoDefaults, type VideoStyle } from './composerTemplates'
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
import type { ProjectVideoEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus, ProjectVideoMeta } from '../../../../../preload/api'

const GENERATE_CLASS =
  'flex h-[38px] flex-none items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-semibold text-bg-hi cursor-pointer enabled:hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

const REGENERATE_CLASS =
  'inline-flex h-8 flex-none items-center gap-[7px] whitespace-nowrap rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12.5px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

const CARD_CLASS = 'flex min-w-0 flex-col rounded-xl border border-rule-structural bg-bg-hi px-4 py-3.5'

const LABEL_CLASS = 'font-mono text-[10.5px] tracking-[.1em] text-fg-faint'

/** The thumbnail's `m:ss` badge; the resets keep a style's uppercase / italic / weight off it. */
const DURATION_CLASS =
  'absolute bottom-[3px] right-[3px] rounded-[3px] bg-fg/80 px-1 font-mono text-[9.5px] font-normal normal-case not-italic leading-[1.4] tracking-normal text-bg'

/** Composer template Regenerate starts from when an entry's meta is unreadable (it records no settings). */
const FALLBACK_TEMPLATE = 'demo'

/** QUALITY REPORT's four numbers (§5), in display order. */
const REPORT_STATS = [
  { key: 'lufs', label: 'LUFS', unit: '' },
  { key: 'truePeakDb', label: 'true peak dB', unit: '' },
  { key: 'speechS', label: 'speech', unit: 's' },
  { key: 'readingGrade', label: 'reading grade', unit: '' },
] as const

/** `n` (+ `unit`), or `-` for a missing or non-finite number. */
function fmt(n: number | null | undefined, unit = ''): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n}${unit}` : '-'
}

/** `m:ss` — the thumbnail's duration badge (prototype `clock`). */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The `VIDEO_STYLES` swatch for a recorded `meta.style`, matched case-insensitively; anything else shows as Auto. */
function videoStyle(style: string | undefined): VideoStyle {
  const id = (style ?? '').trim().toLowerCase()
  return VIDEO_STYLES.find((s) => s.id.toLowerCase() === id) ?? VIDEO_STYLES[0]
}

/** `videoPromptLines` always ends its fixed lines with `Character: on|off`; whatever follows is the Focus text. */
function splitFocus(lines: string[]): { fixed: string[]; focus: string } {
  const at = lines.findIndex((line) => line.startsWith('Character: '))
  return at < 0 ? { fixed: lines, focus: '' } : { fixed: lines.slice(0, at + 1), focus: lines.slice(at + 1).join('\n') }
}

/** `Video length: <n>` from the sent lines, in seconds; null when unknown (no launch from this window). */
function sentLength(lines: readonly string[] | undefined): number | null {
  const n = Number(sentValue(lines, 'Video length'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * A new video's building title (prototype `create`): `<target> spotlight` for a Feature, a Blog
 * post's file name, else the name of the kind's template.
 */
function videoBuildTitle(lines: readonly string[]): string {
  const kind = sentValue(lines, 'Video kind') ?? ''
  const target = (sentValue(lines, 'Video target') ?? '').trim()
  if (target && kind === 'Feature') return `${target} spotlight`
  if (target && kind === 'Blog post') {
    const file = target.split('/').pop() ?? target
    return file.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').trim() || target
  }
  return VIDEO_TEMPLATES.find((t) => t.kind === kind)?.name ?? (kind || 'New video')
}

/** A building video's title-bar sub (prototype): `<kind> · <len>s · <style>` from the sent lines. */
function videoBuildSub(lines: readonly string[] | undefined): string {
  const len = sentLength(lines)
  return [
    sentValue(lines, 'Video kind')?.toLowerCase().replace(/\s+/g, '-'),
    len === null ? null : `${len}s`,
    sentValue(lines, 'Video style')?.toLowerCase(),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Title-bar sub: `<kind> · <len>s · <style> · <ago>`; just `<ago>` for an entry with unreadable meta. */
function videoSub(entry: ProjectVideoEntry): string {
  const m = entry.meta
  const parts = m ? [m.kind, `${m.lengthS}s`, m.style.trim().toLowerCase()] : []
  return [...parts, createdLabel(entry)].filter(Boolean).join(' · ')
}

function Thumbnail({ entry }: { entry: ProjectVideoEntry }) {
  const m = entry.meta
  const style = videoStyle(m?.style)
  // Decorative: the row text already carries the title and length.
  return (
    <span
      data-testid="video-thumb"
      data-style={style.id}
      aria-hidden="true"
      className={`relative flex aspect-video w-[86px] flex-none items-center justify-center overflow-hidden rounded-md px-1.5 py-1 ${style.className}`}
    >
      <span data-col="thumb-title" className="line-clamp-3 break-words text-center text-[10.5px] leading-[1.1]">
        {m?.title || entry.id}
      </span>
      {m && (
        <span data-testid="video-duration" className={DURATION_CLASS}>
          {clock(m.lengthS)}
        </span>
      )}
    </span>
  )
}

/** A building row's content (§1, render 04): `· · ·` thumbnail, title, accent build state, a 3px bar. */
function VideoBuildingRow({ title, lengthS, status }: { title: string; lengthS: number | null; status: MacroJobStatus }) {
  return (
    <span data-testid="project-home-building-row" data-state={status.state} className="flex items-start gap-[11px]">
      <span
        data-testid="video-thumb"
        data-style="building"
        aria-hidden="true"
        className="relative flex aspect-video w-[86px] flex-none items-center justify-center overflow-hidden rounded-md bg-rule-inner px-1.5 py-1 text-fg-faint"
      >
        <span data-col="thumb-title" className="text-center text-[10.5px] leading-[1.1]">
          · · ·
        </span>
        {lengthS !== null && (
          <span data-testid="video-duration" className={DURATION_CLASS}>
            {clock(lengthS)}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span data-col="title" className="truncate text-[13px] font-semibold">
          {title}
        </span>
        <BuildingMeta status={status} />
        <span className="block pt-[3px]">
          <IndeterminateBar size="row" />
        </span>
      </span>
    </span>
  )
}

function videoRow(e: ProjectVideoEntry): LibraryRow {
  const m = e.meta
  return {
    id: e.id,
    title: m?.title,
    content: (
      <span className="flex items-start gap-[11px]">
        <Thumbnail entry={e} />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {m ? (
            <span data-col="title" className="truncate text-[13px] font-semibold">
              {m.title}
            </span>
          ) : (
            <span data-col="title" className="break-words text-xs text-red-400">
              {`${e.id}: ${e.error ?? 'unreadable meta'}`}
            </span>
          )}
          <span data-col="meta" className="font-mono text-[10.5px] text-fg-faint">
            {m && (
              <>
                <span data-col="kind">{m.kind}</span>
                {' · '}
                <span data-col="length">{`${m.lengthS}s`}</span>
                {' · '}
              </>
            )}
            <span data-col="created">{createdLabel(e)}</span>
          </span>
          {m && (
            <span data-col="report" className="font-mono text-[10.5px] text-fg-faint">
              {'LUFS '}
              <span data-col="lufs">{fmt(m.report.lufs)}</span>
              {' · grade '}
              <span data-col="grade">{fmt(m.report.readingGrade)}</span>
            </span>
          )}
        </span>
      </span>
    ),
  }
}

function SourcesCard({ sources }: { sources: ProjectVideoMeta['sources'] }) {
  return (
    <section data-testid="video-sources" aria-label="Sources" className={`${CARD_CLASS} gap-2.5`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={LABEL_CLASS}>SOURCES</span>
        <span data-testid="video-sources-count" className="font-mono text-[10.5px] text-fg-faint">
          {sources.length === 1 ? '1 claim' : `${sources.length} claims`}
        </span>
      </div>
      {sources.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {sources.map((s, i) => (
            <li key={i} data-testid="video-source" className="flex flex-col gap-0.5 border-t border-bg-elev pt-[9px]">
              <span data-col="claim" className="break-words text-[13px] text-fg">
                {s.claim}
              </span>
              <span data-col="ref" className="break-words font-mono text-[10.5px] text-fg-faint">
                {[s.source, s.ref].filter(Boolean).join(' › ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function QualityCard({ report }: { report: ProjectVideoMeta['report'] }) {
  return (
    <section data-testid="video-report" aria-label="Quality report" className={`${CARD_CLASS} gap-3`}>
      <span className={LABEL_CLASS}>QUALITY REPORT</span>
      <div className="grid grid-cols-4 gap-2">
        {REPORT_STATS.map((s) => (
          <div key={s.key} data-stat={s.key} className="flex min-w-0 flex-col gap-0.5">
            <span data-col="value" className="text-[17px] font-semibold text-fg">
              {fmt(report[s.key], s.unit)}
            </span>
            <span data-col="label" className="font-mono text-[10px] text-fg-faint">
              {s.label}
            </span>
          </div>
        ))}
      </div>
      {report.checks.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {report.checks.map((c, i) => (
            <li
              key={`${c.id}-${i}`}
              data-testid="video-check"
              data-ok={c.ok ? 'true' : 'false'}
              className="flex items-center gap-2 text-[12.5px] text-fg-dim"
            >
              <span
                data-testid="video-check-icon"
                role="img"
                aria-label={c.ok ? 'Passed' : 'Failed'}
                className={c.ok ? 'flex flex-none text-sage-dark' : 'flex flex-none text-accent'}
              >
                <AlmanacIcon name={c.ok ? 'check' : 'x'} size={13} stroke={2.4} />
              </span>
              <span className="min-w-0 break-words">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface VideosPaneProps {
  cwd?: string | null
  /** Videos, newest first (ProjectHome's `useProjectPagesOutput`). */
  entries: ProjectVideoEntry[]
  /** `builtin-demo-video`; without it Generate video and Regenerate… stay disabled. */
  macro: Macro | undefined
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
  /** The video macro's job. Queued / running disables both buttons and shows the building row; failed shows its reason. */
  jobStatus?: MacroJobStatus
  onOpenSession?: (epicId: string) => void
  /** Controlled selection — ProjectPagesSection keeps it across key-button switches. Without `onSelect` the pane keeps its own. */
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** This window's last launch of the video macro (ProjectHome); absent after an app reload. */
  lastLaunch?: BuildLaunch
  /** Reports each launch so ProjectHome can keep it as the macro's `lastLaunch`. */
  onLaunched?: (macroId: string, launch: BuildLaunch) => void
}

export function VideosPane({
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
}: VideosPaneProps) {
  const [ownId, setOwnId] = useState<string | null>(null)
  // Open composer: `{}` = Generate video, `{ regen }` = Regenerate… (mounted per open — it reads its props once).
  const [composer, setComposer] = useState<{ regen?: ComposerRegen } | null>(null)
  const select = onSelect ?? setOwnId
  const pickedId = onSelect ? (selectedId ?? null) : ownId
  const build = isBuilding(jobStatus) ? jobStatus : undefined
  // A Regenerate… from this window rebuilds its video in place; any other build gets a new row on top.
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
  const buildTitle = lastLaunch?.title ?? macro?.label ?? 'New video'
  const buildLength = sentLength(lastLaunch?.lines)
  const failed = failureShown(jobStatus, lastLaunch) ? jobStatus : undefined
  const busy = !macro || launching !== null || build !== undefined

  const launch = (lines: string[], replaceEntryId?: string) => {
    setComposer(null)
    if (!macro) return
    const { fixed, focus } = splitFocus(lines)
    const extra = fitInstructions(fixed, focus, replaceEntryId ? [`Replace entry: ${replaceEntryId}`] : [])
    const entry = replaceEntryId ? entries.find((e) => e.id === replaceEntryId) : undefined
    onLaunched?.(macro.id, {
      title: entry ? entry.meta?.title || entry.id : videoBuildTitle(lines),
      lines: extra.split('\n'),
      ...(replaceEntryId ? { replaceEntryId } : {}),
      at: Date.now(),
    })
    // The build shows in this row once its job is queued.
    select(replaceEntryId ?? BUILDING_ROW_ID)
    onLaunch(macro, extra)
  }

  const regenerate = (entry: ProjectVideoEntry) => {
    const { tplId, cfg } = entry.meta
      ? videoCfgFromEntry(entry.meta)
      : { tplId: FALLBACK_TEMPLATE, cfg: videoDefaults(FALLBACK_TEMPLATE) }
    setComposer({ regen: { entryId: entry.id, title: entry.meta?.title || entry.id, tplId, cfg } })
  }

  const composerNode = composer && (
    <GenerateComposer kind="video" regen={composer.regen} onClose={() => setComposer(null)} onGenerate={launch} />
  )
  const generateButton = (fullWidth: boolean) => (
    <button
      type="button"
      data-testid="project-home-generate"
      data-kind="video"
      disabled={busy}
      title={macro ? undefined : 'The built-in Demo Video macro is not available for this project'}
      onClick={() => setComposer({})}
      className={`${GENERATE_CLASS} ${fullWidth ? 'w-full' : 'px-4'}`}
    >
      <AlmanacIcon name="plus" size={14} stroke={2} />
      {macro && launching === macro.id ? 'Starting…' : 'Generate video'}
    </button>
  )

  const rows: LibraryRow[] = entries.map((e) =>
    build && e.id === replacingId
      ? {
          id: e.id,
          title: e.meta?.title,
          content: <VideoBuildingRow title={buildTitle} lengthS={buildLength ?? e.meta?.lengthS ?? null} status={build} />,
        }
      : videoRow(e),
  )
  if (build && !replacingId) {
    rows.unshift({ id: BUILDING_ROW_ID, content: <VideoBuildingRow title={buildTitle} lengthS={buildLength} status={build} /> })
  }
  const title = buildingShown ? buildTitle : selected ? selected.meta?.title || selected.id : ''
  const sub = buildingShown ? videoBuildSub(lastLaunch?.lines) : selected ? videoSub(selected) : ''
  const epicId = build?.epicId ?? null

  // Both branches share one composer slot, so the first video landing while the composer is open keeps its form.
  return (
    <>
      {shownId !== null ? (
        <div
          data-testid="project-home-library"
          className="grid min-h-0 flex-1 gap-[20px]"
          style={{ gridTemplateColumns: '252px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)' }}
        >
          <div className="flex min-h-0 flex-col gap-3">
            {generateButton(true)}
            <div
              data-testid="project-home-videos-header"
              className="flex flex-none items-baseline justify-between px-0.5 pt-0.5 font-mono text-[10.5px] text-fg-faint"
            >
              <span className="tracking-[.1em]">VIDEOS</span>
              <span data-testid="project-home-videos-count">{rows.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-px">
              {failed && <BuildFailedRow status={failed} onOpenSession={onOpenSession} />}
              {/* No cwd while the building row is shown: Rename · Delete sit under a selected, non-building row only (§1). */}
              <ProjectLibraryList
                layout="v2"
                label="Videos"
                itemTestId="video-item"
                cwd={buildingShown ? null : cwd}
                kind="video"
                rows={rows}
                selectedId={shownId}
                onSelect={select}
              />
            </div>
          </div>
          <div data-testid="project-home-content" className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pr-0.5">
            <div className="flex flex-none flex-wrap items-center gap-3">
              <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
                <h2
                  data-testid="project-home-video-title"
                  className="m-0 break-words font-serif text-[22px] font-semibold leading-[1.15] text-fg"
                >
                  {title}
                </h2>
                <span data-testid="project-home-video-sub" className="font-mono text-[11px] text-fg-faint">
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
            {build && buildingShown ? (
              <BuildingPanel
                kind="video"
                title={buildTitle}
                lines={lastLaunch?.lines}
                agentName={macro?.agentName}
                jobStatus={build}
                onOpenSession={onOpenSession}
              />
            ) : selected?.meta ? (
              <>
                <div className="flex-none overflow-hidden rounded-xl border border-rule-structural bg-bg-hi">
                  <VideoPlayer path={selected.path} mtimeMs={selected.mtimeMs} />
                </div>
                <div
                  data-testid="video-cards"
                  className="grid flex-none gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}
                >
                  <SourcesCard sources={selected.meta.sources} />
                  <QualityCard report={selected.meta.report} />
                </div>
              </>
            ) : (
              selected && (
                <p
                  data-testid="project-home-video-error"
                  className="m-0 flex-none rounded-xl border border-rule-structural bg-bg-hi p-4 text-xs text-red-400"
                >
                  {selected.error ?? 'unreadable meta'}
                </p>
              )
            )}
          </div>
        </div>
      ) : (
        <div data-testid="video-page-empty" className="flex min-h-0 flex-1 justify-center overflow-auto py-16">
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs text-fg-faint">No videos yet.</span>
            {generateButton(false)}
            {failed && <JobStatusLine status={failed} onOpenSession={onOpenSession} />}
          </div>
        </div>
      )}
      {composerNode}
    </>
  )
}
