/**
 * Project Home's two pages: Knowledge Pages (list + the selected page in the
 * static script-free HtmlFrame) and Video Pages (playlist + VideoPlayer). Each
 * page has its own generate MacroButton, build-status line and empty state.
 *
 * `knowledge`/`videos`/`loaded` come from ProjectHome's single
 * `useProjectPagesOutput` call; `macros`/`launching`/`onLaunch` come from its
 * `useMacroLaunch` wiring. Purely presentational — no store access here.
 */
import { useEffect, useState } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import { VideoPlayer } from './VideoPlayer'
import { ProjectLibraryList, type LibraryRow } from './ProjectLibraryList'
import type { ProjectKnowledgeEntry, ProjectVideoEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../preload/api'

const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

const DEMO_VIDEO_STYLES = ['Auto', 'Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography'] as const
const DEMO_VIDEO_LENGTHS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
] as const

const DEMO_VIDEO_KINDS = ['Project demo', 'Blog post', 'Feature'] as const

const KNOWLEDGE_PAGE_KINDS = ['Overview', 'How it works', 'FAQ', 'Custom topic'] as const

function macroButtonLabel(macro: Macro, has: boolean): string {
  return has ? `Regenerate ${macro.label}` : `Generate ${macro.label}`
}

function JobStatusLine({ status, onOpenSession }: { status: MacroJobStatus; onOpenSession?: (epicId: string) => void }) {
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

function MacroButton({
  macro,
  has,
  launching,
  onLaunch,
  status,
  onOpenSession,
}: {
  macro: Macro
  has: boolean
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
  status?: MacroJobStatus
  onOpenSession?: (epicId: string) => void
}) {
  const [extra, setExtra] = useState('')
  const [style, setStyle] = useState<string>('Auto')
  const [length, setLength] = useState<string>('30')
  const [pageKind, setPageKind] = useState<string>('Overview')
  const [topic, setTopic] = useState('')
  const [videoKind, setVideoKind] = useState<string>('Project demo')
  const [target, setTarget] = useState('')
  const building = status?.state === 'queued' || status?.state === 'running'
  const disabled = launching !== null || building
  const showExtraInput = has
  const showStyle = macro.id === 'builtin-demo-video'
  const showPageKind = macro.id === 'builtin-project-home'

  const fire = () => {
    const trimmed = extra.trim()
    const styleLine = showStyle && style !== 'Auto' ? `Video style: ${style}` : ''
    const lengthLine = showStyle && length === '60' ? 'Video length: 60' : ''
    let pageLine = ''
    if (showPageKind && pageKind === 'Custom topic') {
      const t = topic.trim()
      pageLine = t ? `Page: Custom topic: ${t}` : ''
    } else if (showPageKind && pageKind !== 'Overview') pageLine = `Page: ${pageKind}`
    const kindLine = showStyle && videoKind !== 'Project demo' ? `Video kind: ${videoKind}` : ''
    const targetText = target.trim()
    const targetLine = showStyle && targetText ? `Video target: ${targetText}` : ''
    const combined = [pageLine, kindLine, targetLine, styleLine, lengthLine, trimmed].filter(Boolean).join('\n')
    onLaunch(macro, combined || undefined)
    setExtra('')
    setTopic('')
    setTarget('')
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      {showPageKind && (
        <select
          data-testid="project-home-page-kind"
          aria-label="Page"
          value={pageKind}
          onChange={(e) => setPageKind(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {KNOWLEDGE_PAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      )}
      {showPageKind && pageKind === 'Custom topic' && (
        <input
          type="text"
          data-testid="project-home-page-topic"
          aria-label="Custom topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={disabled}
          placeholder="Topic for this page"
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg placeholder:text-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
        />
      )}
      {showStyle && (
        <select
          data-testid="project-home-demo-kind"
          aria-label="Video kind"
          value={videoKind}
          onChange={(e) => setVideoKind(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {DEMO_VIDEO_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      )}
      {showStyle && (
        <input
          type="text"
          data-testid="project-home-demo-target"
          aria-label="Video target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={disabled}
          placeholder="Optional: post path or URL (Blog post), feature name (Feature)"
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg placeholder:text-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
        />
      )}
      {showStyle && (
        <select
          data-testid="project-home-demo-style"
          aria-label="Video style"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {DEMO_VIDEO_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
      {showStyle && (
        <select
          data-testid="project-home-demo-length"
          aria-label="Video length"
          value={length}
          onChange={(e) => setLength(e.target.value)}
          disabled={disabled}
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {DEMO_VIDEO_LENGTHS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      )}
      {showExtraInput && (
        <input
          type="text"
          data-testid="project-home-macro-extra"
          data-macro-id={macro.id}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          disabled={disabled}
          placeholder="Optional: extra instructions for this regeneration"
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg placeholder:text-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
        />
      )}
      <button
        type="button"
        data-testid="project-home-macro"
        data-macro-id={macro.id}
        disabled={disabled}
        onClick={fire}
        className={BUTTON_CLASS}
      >
        <span className="inline-flex">
          <AlmanacIcon name="sparkle" size={14} />
        </span>
        {building ? 'Building…' : launching === macro.id ? 'Starting…' : macroButtonLabel(macro, has)}
      </button>
      {status && <JobStatusLine status={status} onOpenSession={onOpenSession} />}
    </div>
  )
}

type Page = 'knowledge' | 'videos'

const PAGE_OPTIONS: { value: Page; label: string }[] = [
  { value: 'knowledge', label: 'Knowledge Pages' },
  { value: 'videos', label: 'Video Pages' },
]

function PageSwitch({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  return (
    <div
      data-testid="project-home-page-switch"
      className="flex gap-0.5 p-0.5 rounded bg-bg-elev shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] text-[11px]"
    >
      {PAGE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-page={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2 py-1 rounded whitespace-nowrap font-semibold ${
            page === opt.value ? 'bg-bg-hi text-fg shadow-sm' : 'text-fg-faint hover:text-fg'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** Selected id, defaulting to the newest (first) entry; survives list refreshes while the id still exists. */
function pickSelected<T extends { id: string }>(entries: T[], id: string | null): T | null {
  return entries.find((e) => e.id === id) ?? entries[0] ?? null
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

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '-' : String(n)
}

function createdLabel(entry: { mtimeMs: number; meta: { createdAt: string } | null }): string {
  const t = entry.meta ? Date.parse(entry.meta.createdAt) : NaN
  return formatAgo(Number.isFinite(t) ? t : entry.mtimeMs, Date.now())
}

function knowledgeRow(e: ProjectKnowledgeEntry): LibraryRow {
  return {
    id: e.id,
    title: e.meta?.title,
    content: e.meta ? (
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{e.meta.title}</span>
        <span className="font-mono text-[10.5px] text-fg-faint">{createdLabel(e)}</span>
      </span>
    ) : (
      <span className="text-red-400">{e.id}: {e.error ?? 'unreadable meta'}</span>
    ),
  }
}

function videoRow(e: ProjectVideoEntry): LibraryRow {
  const m = e.meta
  return {
    id: e.id,
    title: m?.title,
    content: m ? (
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{m.title}</span>
        <span className="flex flex-wrap gap-x-2 font-mono text-[10.5px] text-fg-faint">
          <span data-col="kind">{m.kind}</span>
          <span data-col="length">{m.lengthS}s</span>
          <span data-col="created">{createdLabel(e)}</span>
          <span>LUFS <span data-col="lufs">{fmt(m.report.lufs)}</span></span>
          <span>grade <span data-col="grade">{fmt(m.report.readingGrade)}</span></span>
        </span>
      </span>
    ) : (
      <span className="text-red-400">{e.id}: {e.error ?? 'unreadable meta'}</span>
    ),
  }
}

export function ProjectPagesSection({
  cwd,
  knowledge,
  videos,
  loaded,
  macros,
  launching,
  onLaunch,
  jobStatus,
  onOpenSession,
}: {
  cwd?: string | null
  knowledge: ProjectKnowledgeEntry[]
  videos: ProjectVideoEntry[]
  loaded: boolean
  macros: Macro[]
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
  jobStatus?: Record<string, MacroJobStatus>
  onOpenSession?: (epicId: string) => void
}) {
  const [page, setPage] = useState<Page>('knowledge')
  const [knowledgeId, setKnowledgeId] = useState<string | null>(null)
  const [videoId, setVideoId] = useState<string | null>(null)

  if (!loaded) return null

  const isKnowledge = page === 'knowledge'
  const macro = macros.find((m) => m.id === (isKnowledge ? 'builtin-project-home' : 'builtin-demo-video'))
  const entries = isKnowledge ? knowledge : videos
  const has = entries.length > 0
  const button = macro ? (
    <MacroButton
      macro={macro}
      has={has}
      launching={launching}
      onLaunch={onLaunch}
      status={jobStatus?.[macro.id]}
      onOpenSession={onOpenSession}
    />
  ) : null

  const selectedK = pickSelected(knowledge, knowledgeId)
  const selectedV = pickSelected(videos, videoId)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2.5">
        <PageSwitch page={page} onChange={setPage} />
        <div className="flex items-center gap-2.5">{button}</div>
      </div>
      {!has ? (
        <div data-testid={isKnowledge ? 'knowledge-page-empty' : 'video-page-empty'} className="flex justify-center py-16">
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs text-fg-faint">
              {isKnowledge ? 'No knowledge pages yet.' : 'No videos yet.'}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: '240px 1fr' }}>
          {isKnowledge ? (
            <ProjectLibraryList
              label="Knowledge pages"
              itemTestId="knowledge-page-item"
              cwd={cwd}
              kind="knowledge"
              rows={knowledge.map(knowledgeRow)}
              selectedId={selectedK?.id ?? null}
              onSelect={setKnowledgeId}
            />
          ) : (
            <ProjectLibraryList
              label="Videos"
              itemTestId="video-item"
              cwd={cwd}
              kind="video"
              rows={videos.map(videoRow)}
              selectedId={selectedV?.id ?? null}
              onSelect={setVideoId}
            />
          )}
          <div
            className="overflow-hidden rounded-xl border border-line bg-bg-hi"
            style={{ height: 'calc(100vh - 200px)', minHeight: 520 }}
          >
            {isKnowledge ? (
              selectedK && <KnowledgeFrame entry={selectedK} />
            ) : (
              selectedV &&
              (selectedV.meta ? (
                <VideoPlayer path={selectedV.path} mtimeMs={selectedV.mtimeMs} />
              ) : (
                <p className="p-4 text-xs text-red-400">{selectedV.error ?? 'unreadable meta'}</p>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
