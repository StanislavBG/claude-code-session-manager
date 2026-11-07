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
 * entry in place (§7) — fitted under the IPC cap by PagesPane's `fitInstructions`.
 *
 * Presentational: entries, macro, launch state and job status come from ProjectHome through
 * ProjectPagesSection; rename / delete go through ProjectLibraryList's `v2` layout.
 */
import { useState } from 'react'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { VideoPlayer } from './VideoPlayer'
import { JobStatusLine, createdLabel, fitInstructions } from './PagesPane'
import { ProjectLibraryList, type LibraryRow } from './ProjectLibraryList'
import { GenerateComposer, type ComposerRegen } from './GenerateComposer'
import { VIDEO_STYLES, videoCfgFromEntry, videoDefaults, type VideoStyle } from './composerTemplates'
import type { ProjectVideoEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus, ProjectVideoMeta } from '../../../../../preload/api'

const GENERATE_CLASS =
  'flex h-[38px] flex-none items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-semibold text-bg-hi cursor-pointer enabled:hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

const REGENERATE_CLASS =
  'inline-flex h-8 flex-none items-center gap-[7px] whitespace-nowrap rounded-lg border border-rule-structural bg-bg-hi px-3 text-[12.5px] font-semibold text-fg cursor-pointer enabled:hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed'

const CARD_CLASS = 'flex min-w-0 flex-col rounded-xl border border-rule-structural bg-bg-hi px-4 py-3.5'

const LABEL_CLASS = 'font-mono text-[10.5px] tracking-[.1em] text-fg-faint'

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
        <span
          data-testid="video-duration"
          className="absolute bottom-[3px] right-[3px] rounded-[3px] bg-fg/80 px-1 font-mono text-[9.5px] font-normal normal-case not-italic leading-[1.4] tracking-normal text-bg"
        >
          {clock(m.lengthS)}
        </span>
      )}
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
  /** The video macro's job. Queued / running disables both buttons (the building UI is PRD ph2-building-state). */
  jobStatus?: MacroJobStatus
  onOpenSession?: (epicId: string) => void
  /** Controlled selection — ProjectPagesSection keeps it across key-button switches. Without `onSelect` the pane keeps its own. */
  selectedId?: string | null
  onSelect?: (id: string) => void
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
}: VideosPaneProps) {
  const [ownId, setOwnId] = useState<string | null>(null)
  // Open composer: `{}` = Generate video, `{ regen }` = Regenerate… (mounted per open — it reads its props once).
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
    const { fixed, focus } = splitFocus(lines)
    onLaunch(macro, fitInstructions(fixed, focus, replaceEntryId ? [`Replace entry: ${replaceEntryId}`] : []))
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
  const statusLine = jobStatus && <JobStatusLine status={jobStatus} onOpenSession={onOpenSession} />
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

  // Both branches share one composer slot, so the first video landing while the composer is open keeps its form.
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
              data-testid="project-home-videos-header"
              className="flex flex-none items-baseline justify-between px-0.5 pt-0.5 font-mono text-[10.5px] text-fg-faint"
            >
              <span className="tracking-[.1em]">VIDEOS</span>
              <span data-testid="project-home-videos-count">{entries.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-px">
              <ProjectLibraryList
                layout="v2"
                label="Videos"
                itemTestId="video-item"
                cwd={cwd}
                kind="video"
                rows={entries.map(videoRow)}
                selectedId={selected.id}
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
                  {selected.meta?.title || selected.id}
                </h2>
                <span data-testid="project-home-video-sub" className="font-mono text-[11px] text-fg-faint">
                  {videoSub(selected)}
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
            {selected.meta ? (
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
              <p
                data-testid="project-home-video-error"
                className="m-0 flex-none rounded-xl border border-rule-structural bg-bg-hi p-4 text-xs text-red-400"
              >
                {selected.error ?? 'unreadable meta'}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div data-testid="video-page-empty" className="flex min-h-0 flex-1 justify-center overflow-auto py-16">
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs text-fg-faint">No videos yet.</span>
            {generateButton(false)}
            {statusLine}
          </div>
        </div>
      )}
      {composerNode}
    </>
  )
}
