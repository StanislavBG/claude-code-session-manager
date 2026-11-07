/**
 * Project Home's three key buttons — Pages, Videos, Tools — above the section
 * area (Project Home v2 DESIGN_SPEC §1). Purely presentational: ProjectHome
 * owns the active tab and builds each library's numbers with
 * `libraryKeyStats` from its `useProjectPagesOutput` + `useMacroJobStatus`
 * data.
 *
 * Badge = ready + building entries (the rows that library's list shows).
 * Meta line: nothing at all → `Nothing generated yet`; a build queued or
 * running → `<n> building · <m> ready`; else `<n> page(s)|video(s) · latest
 * <ago>`. Tools shows the link-map findings count in an accent badge, hidden
 * while it is unknown (`null`).
 */
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon, type AlmanacIconName } from '../../../layout/AlmanacIcon'
import type { MacroJobStatus } from '../../../../../preload/api'

export type ProjectHomeTab = 'pages' | 'videos' | 'tools'

/** One library's key-button numbers. */
export interface KeyLibraryStats {
  /** Ready (written) entries. */
  count: number
  /** Builds queued or running for the library's macro — 0 or 1 today. */
  building: number
  /** Newest entry's created time in ms; null when there is none. */
  latestMs: number | null
}

interface LibraryEntryTimes {
  mtimeMs: number
  meta: { createdAt: string } | null
}

/**
 * `entries` is one library (knowledge pages or videos); `status` is its
 * generate macro's job (`builtin-project-home` / `builtin-demo-video`). An
 * entry's time is its meta `createdAt`, else its file mtime — the same time
 * the list rows show.
 */
export function libraryKeyStats(entries: readonly LibraryEntryTimes[], status: MacroJobStatus | undefined): KeyLibraryStats {
  let latestMs: number | null = null
  for (const e of entries) {
    const created = e.meta ? Date.parse(e.meta.createdAt) : NaN
    const t = Number.isFinite(created) ? created : e.mtimeMs
    if (Number.isFinite(t) && (latestMs === null || t > latestMs)) latestMs = t
  }
  const building = status?.state === 'queued' || status?.state === 'running' ? 1 : 0
  return { count: entries.length, building, latestMs }
}

export function libraryKeyMeta(stats: KeyLibraryStats, noun: 'page' | 'video', now: number): string {
  if (stats.count === 0 && stats.building === 0) return 'Nothing generated yet'
  if (stats.building > 0) return `${stats.building} building · ${stats.count} ready`
  const counted = `${stats.count} ${noun}${stats.count === 1 ? '' : 's'}`
  return stats.latestMs === null ? counted : `${counted} · latest ${formatAgo(stats.latestMs, now)}`
}

function toolsMeta(findingsCount: number | null): string {
  if (findingsCount === null) return 'Review MD network'
  return `Review MD network · ${findingsCount} finding${findingsCount === 1 ? '' : 's'}`
}

function KeyButton({
  tab,
  label,
  icon,
  meta,
  count,
  accentBadge,
  selected,
  onTabChange,
}: {
  tab: ProjectHomeTab
  label: string
  icon: AlmanacIconName
  meta: string
  count: number | null
  accentBadge: boolean
  selected: boolean
  onTabChange: (tab: ProjectHomeTab) => void
}) {
  let badgeTone = selected ? 'bg-fg-dim text-bg' : 'bg-rule-inner text-fg-dim'
  if (accentBadge) badgeTone = 'bg-accent text-bg-hi'
  return (
    <button
      type="button"
      data-testid="project-home-key"
      data-tab={tab}
      aria-pressed={selected}
      onClick={() => onTabChange(tab)}
      className={`flex min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3 text-left cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        selected ? 'border-fg bg-fg text-bg' : 'border-rule-structural bg-bg-hi text-fg'
      }`}
    >
      <span
        data-testid="project-home-key-icon"
        className={`flex h-9 w-9 flex-none items-center justify-center rounded-[9px] ${
          selected ? 'bg-accent text-bg-hi' : 'bg-rule-inner text-fg-dim'
        }`}
      >
        <AlmanacIcon name={icon} size={19} stroke={1.7} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-testid="project-home-key-label" className="text-[16px] font-semibold tracking-[-0.01em]">
          {label}
        </span>
        <span
          data-testid="project-home-key-meta"
          className={`break-words text-[12px] leading-[1.35] ${selected ? 'text-rule-structural' : 'text-fg-faint'}`}
        >
          {meta}
        </span>
      </span>
      {count !== null && (
        <span
          data-testid="project-home-key-count"
          className={`flex h-[22px] min-w-[24px] flex-none items-center justify-center rounded-[11px] px-[7px] font-mono text-[11.5px] ${badgeTone}`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

export function ProjectHomeKeyButtons({
  tab,
  onTabChange,
  pages,
  videos,
  findingsCount,
}: {
  tab: ProjectHomeTab
  onTabChange: (tab: ProjectHomeTab) => void
  pages: KeyLibraryStats
  videos: KeyLibraryStats
  /** Link-map findings for the Tools badge; null hides the badge. */
  findingsCount: number | null
}) {
  const now = Date.now()
  return (
    <div data-testid="project-home-keys" className="grid flex-none grid-cols-3 gap-3">
      <KeyButton
        tab="pages"
        label="Pages"
        icon="book"
        meta={libraryKeyMeta(pages, 'page', now)}
        count={pages.count + pages.building}
        accentBadge={false}
        selected={tab === 'pages'}
        onTabChange={onTabChange}
      />
      <KeyButton
        tab="videos"
        label="Videos"
        icon="play"
        meta={libraryKeyMeta(videos, 'video', now)}
        count={videos.count + videos.building}
        accentBadge={false}
        selected={tab === 'videos'}
        onTabChange={onTabChange}
      />
      <KeyButton
        tab="tools"
        label="Tools"
        icon="tool"
        meta={toolsMeta(findingsCount)}
        count={findingsCount}
        accentBadge
        selected={tab === 'tools'}
        onTabChange={onTabChange}
      />
    </div>
  )
}
