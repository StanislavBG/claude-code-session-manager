import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Panel } from '../../ui/Panel'
import { ListDetail } from '../../ui/ListDetail'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { EmptyState } from '../../ui/EmptyState'
import { ViewTabs } from '../../ui/ViewTabs'
import { formatBytes } from '../../../lib/formatBytes'
import { formatMtimeMs } from '../../../lib/formatTime'
import { MEMORY_SLUG_RE } from '../../../lib/memorySlug'
import type {
  MemoryEntry,
  MemoryIndexHealth as IndexHealth,
  MemoryStaleEntry,
  MemoryTarget,
} from '../../../../preload/api'
import { toast } from '../../../state/toast'
import { filterEntries } from '../../../lib/staleFilter'
import { MemoryNaturalPanel } from '../MemoryNaturalPanel'
import { MemoryClustersPanel } from './MemoryClustersPanel'
import { MemoryIndexHealth } from './MemoryIndexHealth'

type MemoryView = 'classic' | 'natural' | 'clusters'

interface MemoryStoreViewProps {
  target: MemoryTarget
  cwd: string | null
  /** Rendered in the toolbar after the view tabs (scope label, agent picker, …). */
  toolbarExtra?: ReactNode
  /** Show the Natural view tab (workspace-keyed; needs `target.workspace`). */
  enableNatural?: boolean
  /** Show the Clusters view tab (workspace-keyed; needs `target.workspace`). */
  enableClusters?: boolean
}

/**
 * Editor list+detail over one memory dir (MEMORY.md + topic .md files), for any
 * MemoryTarget — a workspace or a native subagent store. Every IPC call passes
 * `target` through unchanged.
 */
export function MemoryStoreView({
  target: targetProp,
  cwd,
  toolbarExtra,
  enableNatural = false,
  enableClusters = false,
}: MemoryStoreViewProps) {
  // Callers may build `target` inline each render; key on content so refresh/effects stay stable.
  const targetKey = JSON.stringify(targetProp)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => targetProp, [targetKey])
  const workspace = target.workspace ?? ''

  const [view, setView] = useState<MemoryView>('classic')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [staleByName, setStaleByName] = useState<Record<string, MemoryStaleEntry>>({})
  const [staleOnly, setStaleOnly] = useState(false)
  const [memDir, setMemDir] = useState('')
  const [autoMemoryEnabled, setAutoMemoryEnabled] = useState(true)
  const [indexHealth, setIndexHealth] = useState<IndexHealth | undefined>(undefined)

  // Per-entry editor state. Keyed by entry name. Cleared on target switch.
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [savedByName, setSavedByName] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [creatingOpen, setCreatingOpen] = useState(false)

  const refresh = useCallback(async () => {
    const r = await window.api.memory.list(target)
    setEntries(r.entries)
    setMemDir(r.dir ?? '')
    setAutoMemoryEnabled(r.autoMemoryEnabled !== false)
    if (r.error) toast.error(`Memory list failed: ${r.error}`)
    setSelectedName((prev) => {
      if (prev && r.entries.some((e) => e.name === prev)) return prev
      return r.entries[0]?.name ?? null
    })
    try {
      const s = await window.api.memory.stale(target)
      setStaleByName(Object.fromEntries(s.entries.map((e) => [e.name, e])))
      setIndexHealth(s.index)
    } catch (err) {
      setStaleByName({})
      setIndexHealth(undefined)
      toast.error(`Memory staleness check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [target])

  useEffect(() => {
    setDraftByName({})
    setSavedByName({})
    setSelectedName(null)
    setCreatingOpen(false)
    refresh()
  }, [refresh])

  // External-change subscription. Without this, an external `claude` write
  // to the memory dir leaves the UI showing stale state — and saving from
  // the stale draft clobbers Claude's update. Watch the dir; any change inside
  // fires a re-list.
  useEffect(() => {
    if (!memDir) return
    const watchedDir = memDir
    window.api.config.watch([watchedDir])
    const off = window.api.config.onChanged(({ path }) => {
      if (path === watchedDir || path.startsWith(watchedDir + '/')) {
        refresh()
      }
    })
    return () => {
      off()
      window.api.config.unwatch([watchedDir])
    }
  }, [memDir, refresh])

  // Load file body when the selection changes (only if not yet cached).
  useEffect(() => {
    if (!selectedName) return
    if (draftByName[selectedName] !== undefined) return
    let cancelled = false
    ;(async () => {
      const r = await window.api.memory.read(selectedName, target)
      if (cancelled) return
      if (r.error) { toast.error(`Memory read failed: ${r.error}`); return }
      setDraftByName((m) => ({ ...m, [selectedName]: r.content }))
      setSavedByName((m) => ({ ...m, [selectedName]: r.content }))
    })()
    return () => {
      cancelled = true
    }
  }, [selectedName, target])

  const staleCount = entries.reduce((n, e) => n + (staleByName[e.name]?.stale ? 1 : 0), 0)
  const filtered = filterEntries(entries, filter, staleOnly, staleByName)
  const selectedEntry = entries.find((e) => e.name === selectedName) ?? null
  const selectedStale = selectedName ? staleByName[selectedName] : undefined
  const draft = selectedName ? draftByName[selectedName] ?? '' : ''
  const saved = selectedName ? savedByName[selectedName] ?? '' : ''
  const dirty = selectedName ? draft !== saved : false

  const viewOptions = [
    { key: 'classic' as const, label: 'Editor' },
    ...(enableNatural ? [{ key: 'natural' as const, label: 'Natural' }] : []),
    ...(enableClusters ? [{ key: 'clusters' as const, label: 'Clusters' }] : []),
  ]

  const onSave = async () => {
    if (!selectedName) return
    setBusy(true)
    const r = await window.api.memory.write(selectedName, draft, target)
    setBusy(false)
    if (!r.ok) {
      toast.error(`Memory save failed: ${r.error ?? 'unknown error'}`)
      return
    }
    setSavedByName((m) => ({ ...m, [selectedName]: draft }))
    refresh()
  }

  const onDelete = async () => {
    if (!selectedName) return
    if (!window.confirm(`Delete memory "${selectedName}"? This cannot be undone.`)) return
    setBusy(true)
    const r = await window.api.memory.delete(selectedName, target)
    setBusy(false)
    if (!r.ok) {
      toast.error(`Memory delete failed: ${r.error ?? 'unknown error'}`)
      return
    }
    setDraftByName((m) => { const n = { ...m }; delete n[selectedName]; return n })
    setSavedByName((m) => { const n = { ...m }; delete n[selectedName]; return n })
    setSelectedName(null)
    refresh()
  }

  return (
    <Panel
      toolbar={
        <>
          {viewOptions.length > 1 && (
            <>
              <ViewTabs options={viewOptions} active={view} onChange={setView} />
              <span className="mx-2 text-fg-faint">·</span>
            </>
          )}
          {toolbarExtra}
          {toolbarExtra && <span className="mx-2 text-fg-faint">·</span>}
          <span className="text-fg-faint">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
          <div className="flex-1" />
          {view === 'classic' && staleCount > 0 && (
            <button
              onClick={() => setStaleOnly((v) => !v)}
              className={`px-2 py-0.5 text-xs border rounded transition-colors ${
                staleOnly
                  ? 'text-amber-400 border-amber-400/50 bg-amber-400/10'
                  : 'text-fg-dim hover:text-fg border-line hover:border-fg-faint'
              }`}
            >
              Stale only ({staleCount})
            </button>
          )}
          {view === 'classic' && (
            <button
              onClick={() => setCreatingOpen(true)}
              className="px-2 py-0.5 text-xs text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
            >
              + New memory
            </button>
          )}
          {view !== 'clusters' && (
            <button
              onClick={refresh}
              className="ml-2 px-2 py-0.5 text-xs text-fg-faint hover:text-fg-dim border border-line hover:border-fg-faint rounded transition-colors"
            >
              Refresh
            </button>
          )}
        </>
      }
      footer={
        view === 'classic' && selectedEntry ? (
          <div className="px-3 py-1.5 flex items-center gap-3 text-xs">
            <button
              onClick={onSave}
              disabled={!dirty || busy}
              className="px-2 py-0.5 text-xs text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onDelete}
              disabled={busy}
              className="px-2 py-0.5 text-xs text-red-400 hover:text-red-300 border border-line hover:border-red-400/50 rounded transition-colors disabled:opacity-40"
            >
              Delete
            </button>
            {selectedStale?.stale && (
              <span className="text-amber-400/90 truncate" title={selectedStale.reasons.join('; ')}>
                stale · {selectedStale.reasons.join(', ')}
              </span>
            )}
            <span className="text-fg-faint truncate flex-1">{selectedEntry.path}</span>
            {dirty && <span className="text-accent">unsaved</span>}
          </div>
        ) : null
      }
    >
      {view === 'classic' && <MemoryIndexHealth index={indexHealth} autoMemoryEnabled={autoMemoryEnabled} />}
      {view === 'natural' && enableNatural ? (
        <MemoryNaturalPanel workspace={workspace} cwd={cwd ?? undefined} entries={entries} onChanged={refresh} />
      ) : view === 'clusters' && enableClusters ? (
        <MemoryClustersPanel
          workspace={workspace}
          cwd={cwd}
          onOpenMember={(slug) => {
            setSelectedName(`${slug}.md`)
            setView('classic')
          }}
        />
      ) : (
      <ListDetail
        sidebar={
          <div className="py-1">
            <div className="px-2 pb-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-faint italic">
                {entries.length === 0 ? 'no memories yet' : 'no matches'}
              </div>
            ) : (
              filtered.map((e) => {
                const staleInfo = staleByName[e.name]
                const title = staleInfo?.stale ? `${e.path}\nstale: ${staleInfo.reasons.join(', ')}` : e.path
                return (
                  <button
                    key={e.name}
                    onClick={() => setSelectedName(e.name)}
                    className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between ${
                      selectedName === e.name
                        ? 'bg-bg-hi text-fg'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                    }`}
                    title={title}
                  >
                    <span className="truncate flex items-center">
                      <span className="truncate">{e.name.replace(/\.md$/, '')}</span>
                      {staleInfo?.stale && (
                        <span className="ml-1.5 shrink-0 px-1 rounded text-[9px] uppercase tracking-wide text-amber-400/90 border border-amber-400/30">
                          stale
                        </span>
                      )}
                      {indexHealth?.orphans.includes(e.name) && (
                        <span
                          className="ml-1.5 shrink-0 px-1 rounded text-[9px] uppercase tracking-wide text-amber-400/90 border border-amber-400/30"
                          title="Not listed in MEMORY.md — Claude won't see it"
                        >
                          not in index
                        </span>
                      )}
                    </span>
                    <span className="ml-2 text-fg-faint shrink-0 text-[10px]">
                      {formatBytes(e.bytes)} · {formatMtimeMs(e.mtimeMs)}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        }
        detail={
          creatingOpen ? (
            <NewMemoryForm
              target={target}
              dir={memDir}
              onCancel={() => setCreatingOpen(false)}
              onCreated={(name) => {
                setCreatingOpen(false)
                setSelectedName(name)
                refresh()
              }}
            />
          ) : selectedEntry && selectedName ? (
            <div className="h-full flex flex-col">
              <div className="shrink-0 px-3 py-2 border-b border-line text-xs">
                <div className="text-fg truncate">{selectedEntry.name}</div>
                <div className="text-fg-faint truncate">
                  {formatBytes(selectedEntry.bytes)} · modified {formatMtimeMs(selectedEntry.mtimeMs)}
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <MarkdownEditor
                  path={selectedEntry.path}
                  value={draft}
                  onChange={(v) => setDraftByName((m) => ({ ...m, [selectedName]: v }))}
                />
              </div>
            </div>
          ) : (
            <EmptyState
              title={entries.length === 0 ? 'no memories yet' : 'select a memory'}
              hint={
                entries.length === 0
                  ? 'Claude writes to memories during sessions when you ask it to remember things, or you can create one manually with the + New memory button.'
                  : undefined
              }
            />
          )
        }
      />
      )}
    </Panel>
  )
}

function NewMemoryForm({
  target,
  dir,
  onCancel,
  onCreated,
}: {
  target: MemoryTarget
  /** Resolved memory dir from `memory.list().dir`. */
  dir: string
  onCancel: () => void
  onCreated: (name: string) => void
}) {
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalized = slug.trim().toLowerCase()
  const valid = MEMORY_SLUG_RE.test(normalized)

  const submit = async () => {
    if (!valid) {
      setError('Slug must match [a-z0-9-_]+')
      return
    }
    setBusy(true)
    setError(null)
    const name = `${normalized}.md`
    const r = await window.api.memory.create(name, description.trim() || undefined, target)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'create failed')
      return
    }
    onCreated(name)
  }

  return (
    <div className="p-4 max-w-xl space-y-3">
      <div className="text-sm text-fg">New memory</div>
      <div className="space-y-1">
        <label className="block text-xs text-fg-faint">Slug</label>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-notes"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
          />
          <span className="text-xs text-fg-faint">.md</span>
        </div>
        <div className="text-[10px] text-fg-faint">
          Lowercase letters, digits, dashes, underscores. The file is created at
          <code className="ml-1 font-mono text-fg-dim">{dir || '…'}/{normalized || '…'}.md</code>
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-fg-faint">Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="one-line summary"
          className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg"
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="px-3 py-1 text-xs text-fg border border-line hover:bg-bg-hi rounded transition-colors disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1 text-xs text-fg-faint hover:text-fg-dim rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
