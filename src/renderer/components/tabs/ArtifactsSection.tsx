import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactEntry } from '../../../preload/api'
import { formatBytes } from '../../lib/formatBytes'
import { toast } from '../../state/toast'

/**
 * The File Explorer's 'Artifacts' section (Project face): the project's
 * Artifacts store (window.api.artifacts.list → lib/epic/artifactIpc.cjs),
 * newest first, grouped by owning Epic. Renders nothing when the project has
 * no artifacts — no nav tab, no setting. Read-only; a row opens the stored file
 * through the same open-file callback FileTree gets.
 */

const POLL_MS = 5000
const OPS_ARTIFACTS = 'session-manager-operations/artifacts'

/** `<cwd>/session-manager-operations/artifacts` — the store folder. */
export function artifactsDir(cwd: string): string {
  return `${cwd.replace(/\/+$/, '')}/${OPS_ARTIFACTS}`
}

/** Absolute path of one stored artifact: `<store>/<ownerId>/<name>`. */
export function artifactPath(cwd: string, a: Pick<ArtifactEntry, 'ownerId' | 'name'>): string {
  return `${artifactsDir(cwd)}/${a.ownerId}/${a.name}`
}

function createdMs(a: ArtifactEntry): number {
  const v = a.createdAt ? Date.parse(a.createdAt) : NaN
  return Number.isFinite(v) ? v : 0
}

function groupLabel(a: ArtifactEntry): string {
  if (a.epicTitle) return a.epicTitle
  if (a.ownerId.startsWith('_tasks/')) return `Task ${a.ownerId.slice('_tasks/'.length)}`
  return a.ownerId
}

function producerLabel(a: ArtifactEntry): string | null {
  const p = a.producer
  if (!p) return null
  return p.prdSlug ?? (p.taskId ? `task ${p.taskId}` : null) ?? (p.sessionId ? `session ${p.sessionId.slice(0, 8)}` : null) ?? p.epicId
}

interface Group { ownerId: string; label: string; rows: ArtifactEntry[] }

/** Groups by owner; groups ordered by their newest artifact, rows newest first. */
export function groupArtifacts(list: ArtifactEntry[]): Group[] {
  const sorted = [...list].sort((a, b) => createdMs(b) - createdMs(a))
  const byOwner = new Map<string, Group>()
  for (const a of sorted) {
    let g = byOwner.get(a.ownerId)
    if (!g) { g = { ownerId: a.ownerId, label: groupLabel(a), rows: [] }; byOwner.set(a.ownerId, g) }
    g.rows.push(a)
  }
  return [...byOwner.values()]
}

interface Props {
  cwd: string
  onOpenFile: (path: string) => void
}

function ArtifactsSectionComponent({ cwd, onOpenFile }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([])
  const [collapsed, setCollapsed] = useState(false)
  // One toast per failure streak, not one every 5 s.
  const failingRef = useRef(false)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  const refresh = useCallback(() => {
    const api = window.api?.artifacts
    if (!api) return
    const forCwd = cwd
    const fail = (msg: string) => {
      if (cwdRef.current !== forCwd) return
      if (!failingRef.current) toast.error(`Couldn't list artifacts: ${msg}`)
      failingRef.current = true
    }
    void api.list({ cwd: forCwd }).then(
      (r) => {
        if (cwdRef.current !== forCwd) return
        if (!r.ok) { fail(r.error ?? 'unknown error'); return }
        failingRef.current = false
        setArtifacts(Array.isArray(r.artifacts) ? r.artifacts : [])
      },
      (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
    )
  }, [cwd])

  useEffect(() => {
    setArtifacts([])
    failingRef.current = false
    refresh()
    const tick = () => { if (document.visibilityState === 'visible') refresh() }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const openFolder = useCallback(() => {
    const path = artifactsDir(cwd)
    void window.api.shell.open({ as: 'revealPath', path }).then(
      (r) => { if (!r.ok) toast.error(`Couldn't open ${path}: ${r.error ?? 'unknown error'}`) },
      (e: unknown) => toast.error(`Couldn't open ${path}: ${e instanceof Error ? e.message : String(e)}`),
    )
  }, [cwd])

  if (artifacts.length === 0) return null
  const groups = groupArtifacts(artifacts)

  return (
    <div data-testid="artifacts-section" className="border-b border-line">
      <div className="flex items-stretch text-[11px]">
        <button
          type="button"
          data-testid="artifacts-section-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          className="flex-1 min-w-0 flex items-center gap-1 px-3 py-1 text-left uppercase tracking-wide text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
        >
          <span className="shrink-0 w-3">{collapsed ? '▸' : '▾'}</span>
          <span className="truncate">Artifacts</span>
          <span className="shrink-0 normal-case tracking-normal">({artifacts.length})</span>
        </button>
        <button
          type="button"
          data-testid="artifacts-open-folder"
          onClick={openFolder}
          title="Open in OS file manager"
          className="shrink-0 px-2 text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
        >
          Open in OS file manager
        </button>
      </div>
      {!collapsed && (
        <div className="pb-1">
          {groups.map((g) => (
            <div key={g.ownerId} data-testid="artifacts-group">
              <div data-testid="artifacts-group-title" className="px-3 pt-1 text-[11px] text-fg-dim truncate" title={g.label}>
                {g.label}
              </div>
              {g.rows.map((a) => {
                const path = artifactPath(cwd, a)
                const producer = producerLabel(a)
                return (
                  <button
                    key={`${a.ownerId}/${a.name}`}
                    type="button"
                    data-testid="artifacts-row"
                    data-path={path}
                    onClick={() => onOpenFile(path)}
                    title={path}
                    className="w-full flex items-center gap-2 pl-6 pr-3 py-0.5 text-left text-[11.5px] hover:bg-bg-hi transition-colors"
                  >
                    <span className="flex-1 min-w-0 truncate text-fg-dim">{a.title || a.name}</span>
                    <span className="shrink-0 text-[10px] text-fg-faint">{a.kind ?? 'other'}</span>
                    {typeof a.size === 'number' && (
                      <span className="shrink-0 text-[10px] text-fg-faint font-mono">{formatBytes(a.size)}</span>
                    )}
                    {producer && (
                      <span className="shrink-0 max-w-[8rem] truncate text-[10px] text-fg-faint font-mono">{producer}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const ArtifactsSection = memo(ArtifactsSectionComponent)
