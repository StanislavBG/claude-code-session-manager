import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { MarkdownEditor } from '../ui/MarkdownEditor'
import { EmptyState } from '../ui/EmptyState'
import { ViewTabs } from '../ui/ViewTabs'
import { useActiveTab } from '../../lib/useActiveTab'
import { useHomeDir } from '../../lib/useHomeDir'
import { formatBytes } from '../../lib/formatBytes'
import { formatMtimeMs } from '../../lib/formatTime'
import { encodeWorkspace } from '../../lib/encodeWorkspace'
import { MEMORY_SLUG_RE } from '../../lib/memorySlug'
import type { MemoryEntry } from '../../../preload/api'
import { toast } from '../../state/toast'
import { MemoryNaturalPanel } from './MemoryNaturalPanel'
import { SubagentMemoryView } from './memory/SubagentMemoryView'
import { MemoryClustersPanel } from './memory/MemoryClustersPanel'

type MemoryView = 'classic' | 'natural' | 'clusters'
type MemoryScope = 'workspace' | 'subagent'

const SCOPE_OPTIONS = [
  { key: 'workspace' as const, label: 'Workspace' },
  { key: 'subagent' as const, label: 'Subagent' },
]
const SCOPE_LS_KEY = 'sm.memoryTab.scope'

/**
 * Memory — single home for both memory stores, split by scope:
 *   • Workspace — cwd-keyed .md memories (~/.claude/projects/<cwd>/memory/)
 *   • Subagent  — agentId-keyed JSON entries (the old "Agent Memory" tool)
 *
 * Consolidates two former nav destinations (Memory + Agent Memory) that were
 * the same list+detail CRUD over different keys. One surface, scope toggle.
 */
export function Memory() {
  const [scope, setScope] = useState<MemoryScope>(() =>
    localStorage.getItem(SCOPE_LS_KEY) === 'subagent' ? 'subagent' : 'workspace',
  )
  useEffect(() => {
    localStorage.setItem(SCOPE_LS_KEY, scope)
  }, [scope])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={SCOPE_OPTIONS} active={scope} onChange={setScope} />
        <span className="text-[11px] text-fg-faint">
          {scope === 'workspace' ? 'memories scoped to the active project' : 'long-term memory per subagent'}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {scope === 'workspace' ? <WorkspaceMemoryView /> : <SubagentMemoryView />}
      </div>
    </div>
  )
}


function WorkspaceMemoryView() {
  const home = useHomeDir()
  const activeTab = useActiveTab()
  const cwd = activeTab?.cwd ?? null
  const workspace = useMemo(() => encodeWorkspace(cwd), [cwd])

  const [view, setView] = useState<MemoryView>('classic')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Per-entry editor state. Keyed by entry name. Cleared on workspace switch.
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [savedByName, setSavedByName] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [creatingOpen, setCreatingOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!home) return
    const r = await window.api.memory.list(workspace)
    setEntries(r.entries)
    if (r.error) toast.error(`Memory list failed: ${r.error}`)
    setSelectedName((prev) => {
      if (prev && r.entries.some((e) => e.name === prev)) return prev
      return r.entries[0]?.name ?? null
    })
  }, [home, workspace])

  useEffect(() => {
    setDraftByName({})
    setSavedByName({})
    setSelectedName(null)
    refresh()
  }, [workspace, refresh])

  // External-change subscription. Without this, an external `claude` write
  // to the workspace dir leaves the UI showing stale state — and saving from
  // the stale draft clobbers Claude's update (renderer #2 in the
  // consolidation review). Watch the workspace dir; any change inside fires
  // a re-list.
  useEffect(() => {
    if (!home) return
    const workspaceDir = `${home}/.claude/projects/${workspace}/memory`
    window.api.config.watch([workspaceDir])
    const off = window.api.config.onChanged(({ path }) => {
      if (path === workspaceDir || path.startsWith(workspaceDir + '/')) {
        refresh()
      }
    })
    return () => {
      off()
      window.api.config.unwatch([workspaceDir])
    }
  }, [home, workspace, refresh])

  // Load file body when the selection changes (only if not yet cached).
  useEffect(() => {
    if (!selectedName) return
    if (draftByName[selectedName] !== undefined) return
    let cancelled = false
    ;(async () => {
      const r = await window.api.memory.read(selectedName, workspace)
      if (cancelled) return
      if (r.error) { toast.error(`Memory read failed: ${r.error}`); return }
      setDraftByName((m) => ({ ...m, [selectedName]: r.content }))
      setSavedByName((m) => ({ ...m, [selectedName]: r.content }))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedName, workspace])

  if (!home) return <EmptyState title="loading…" />

  const filtered = entries.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
  const selectedEntry = entries.find((e) => e.name === selectedName) ?? null
  const draft = selectedName ? draftByName[selectedName] ?? '' : ''
  const saved = selectedName ? savedByName[selectedName] ?? '' : ''
  const dirty = selectedName ? draft !== saved : false

  const onSave = async () => {
    if (!selectedName) return
    setBusy(true)
    const r = await window.api.memory.write(selectedName, draft, workspace)
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
    const r = await window.api.memory.delete(selectedName, workspace)
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
          <ViewTabs
            options={[
              { key: 'classic', label: 'Editor' },
              { key: 'natural', label: 'Natural' },
              { key: 'clusters', label: 'Clusters' },
            ]}
            active={view}
            onChange={setView}
          />
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">Workspace</span>
          <span className="font-mono text-fg-dim truncate max-w-[24rem]" title={workspace}>{workspace}</span>
          <span className="mx-2 text-fg-faint">·</span>
          <span className="text-fg-faint">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
          <div className="flex-1" />
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
            <span className="text-fg-faint truncate flex-1">{selectedEntry.path}</span>
            {dirty && <span className="text-accent">unsaved</span>}
          </div>
        ) : null
      }
    >
      {view === 'natural' ? (
        <MemoryNaturalPanel workspace={workspace} entries={entries} onChanged={refresh} />
      ) : view === 'clusters' ? (
        <MemoryClustersPanel
          workspace={workspace}
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
              filtered.map((e) => (
                <button
                  key={e.name}
                  onClick={() => setSelectedName(e.name)}
                  className={`w-full text-left px-3 py-1 text-xs flex items-center justify-between ${
                    selectedName === e.name
                      ? 'bg-bg-hi text-fg'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                  }`}
                  title={e.path}
                >
                  <span className="truncate">{e.name.replace(/\.md$/, '')}</span>
                  <span className="ml-2 text-fg-faint shrink-0 text-[10px]">
                    {formatBytes(e.bytes)} · {formatMtimeMs(e.mtimeMs)}
                  </span>
                </button>
              ))
            )}
          </div>
        }
        detail={
          creatingOpen ? (
            <NewMemoryForm
              workspace={workspace}
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
  workspace,
  onCancel,
  onCreated,
}: {
  workspace: string
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
    const r = await window.api.memory.create(name, description.trim() || undefined, workspace)
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
          <code className="ml-1 font-mono text-fg-dim">~/.claude/projects/{workspace}/memory/{normalized || '…'}.md</code>
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
