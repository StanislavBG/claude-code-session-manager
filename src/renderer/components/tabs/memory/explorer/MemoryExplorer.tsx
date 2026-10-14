import { useCallback, useEffect, useMemo, useState } from 'react'
import { Z } from '../../../../lib/zLayers'
import { toast } from '../../../../state/toast'
import { LEARNING_CONTENT } from '../../../learningContent'
import type { MemoryAgent } from '../../../../../preload/api'
import { useMemoryExplorer } from './useMemoryExplorer'
import {
  filterRows,
  lineDiff,
  navCounts,
  sortRows,
  type ExplorerScope,
  type ExplorerView,
  type MemoryRow,
  type SortKey,
} from './model'
import { ExplorerNav } from './ExplorerNav'
import { MemoryListPane } from './MemoryListPane'
import { MemoryReader } from './MemoryReader'
import { MemoryEditorPane } from './MemoryEditorPane'
import { LinksRail } from './LinksRail'
import { AskView } from './AskView'
import { ClustersView } from './ClustersView'
import { SearchPalette } from './SearchPalette'
import { DeleteMemoryDialog } from './DeleteMemoryDialog'
import { UndoBar } from './UndoBar'

const SCOPE_LS_KEY = 'sm.memoryTab.scope'
const AGENT_PREFIX = 'agent:'

type Mode = 'read' | 'source' | 'edit' | 'new'
type Overlay = 'learn' | 'palette' | 'delete' | null
interface Fix {
  state: 'idle' | 'checking' | 'proposed'
  diff: { sign: '−' | '+' | ' '; text: string }[]
  summary: string
  action: 'update' | 'delete' | 'fold' | 'keep'
  reason: string
  fold: { target: string; anchor: string; insert: string } | null
}
interface UndoMsg { message: string; undo?: () => void }

const NEW_TEMPLATE = 'One-line summary of the fact or rule.\n\n**Why:**\n\n**How to apply:**'
const IDLE_FIX: Fix = { state: 'idle', diff: [], summary: '', action: 'update', reason: '', fold: null }
const stem = (s: string): string => s.replace(/\.md$/, '')
const basename = (p: string | null): string => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : 'workspace')

function stripFront(src: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  return (m ? src.slice(m[0].length) : src).replace(/^\s*\n/, '')
}

function readStoredScopeKey(): string {
  try {
    const v = localStorage.getItem(SCOPE_LS_KEY)
    return v && v.startsWith(AGENT_PREFIX) ? v : 'workspace'
  } catch {
    return 'workspace'
  }
}

/** Page shell of the Memory tab. Owns the persisted scope; the body remounts per scope so view/selection reset. */
export function MemoryExplorer({ cwd }: { cwd: string | null }) {
  const [storedKey, setStoredKey] = useState(readStoredScopeKey)
  const [known, setKnown] = useState<MemoryAgent[]>([])
  const [wsCount, setWsCount] = useState(0)

  const scopeKey = useMemo(() => {
    if (!storedKey.startsWith(AGENT_PREFIX)) return 'workspace'
    const name = storedKey.slice(AGENT_PREFIX.length)
    return known.some((a) => a.name === name) ? storedKey : 'workspace'
  }, [storedKey, known])

  const scope = useMemo<ExplorerScope>(() => {
    if (scopeKey === 'workspace') return { kind: 'workspace' }
    const agent = known.find((a) => a.name === scopeKey.slice(AGENT_PREFIX.length))
    return agent ? { kind: 'agent', agent } : { kind: 'workspace' }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  const onScope = useCallback((s: ExplorerScope) => {
    const key = s.kind === 'agent' ? `${AGENT_PREFIX}${s.agent.name}` : 'workspace'
    try { localStorage.setItem(SCOPE_LS_KEY, key) } catch { /* storage unavailable */ }
    setStoredKey(key)
  }, [])

  const onAgents = useCallback((a: MemoryAgent[]) => { if (a.length > 0) setKnown(a) }, [])

  return (
    <ExplorerBody
      key={scopeKey}
      scope={scope}
      cwd={cwd}
      onScope={onScope}
      onAgents={onAgents}
      wsCount={wsCount}
      onWsCount={setWsCount}
    />
  )
}

interface BodyProps {
  scope: ExplorerScope
  cwd: string | null
  onScope: (s: ExplorerScope) => void
  onAgents: (a: MemoryAgent[]) => void
  wsCount: number
  onWsCount: (n: number) => void
}

function ExplorerBody({ scope, cwd, onScope, onAgents, wsCount, onWsCount }: BodyProps) {
  const ex = useMemoryExplorer(scope, cwd)
  const { actions, rows, clusters } = ex
  const agent = scope.kind === 'agent' ? scope.agent : null
  const noMemory = agent !== null && agent.memoryScope === null
  const scopeName = agent ? agent.name : basename(cwd)

  const [view, setView] = useState<ExplorerView>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('read')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('recent')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [fix, setFix] = useState<Fix>(IDLE_FIX)
  const [proposed, setProposed] = useState('')
  const [appliedSlug, setAppliedSlug] = useState<string | null>(null)
  const [undo, setUndo] = useState<UndoMsg | null>(null)
  const [askCtx, setAskCtx] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [draftOrig, setDraftOrig] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState<{ name: string; text: string | null } | null>(null)

  useEffect(() => { onAgents(ex.agents) }, [ex.agents, onAgents])
  useEffect(() => {
    if (!agent && !ex.loading) onWsCount(rows.length)
  }, [agent, ex.loading, rows.length, onWsCount])

  const archivedRows = useMemo<MemoryRow[]>(
    () => ex.archived.map((name) => ({
      name, slug: stem(name), path: `${ex.dir}/${name}`, description: '', bytes: 0, mtimeMs: 0, ageDays: 0,
      stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], broken: false, danglingLinks: [],
      outLinks: [], inLinks: [], notIndexed: false, clusterId: null, type: null, originSessionId: null,
    })),
    [ex.archived, ex.dir],
  )

  const isBrowse = view !== 'ask' && view !== 'clusters'
  const listRows = useMemo(() => {
    if (view === 'archived') {
      const needle = query.trim().toLowerCase()
      return archivedRows.filter((r) => !needle || r.slug.toLowerCase().includes(needle))
    }
    return sortRows(filterRows(rows, view, query), sort)
  }, [view, rows, archivedRows, query, sort])

  const selRow = useMemo(
    () => rows.find((r) => r.name === selected) ?? archivedRows.find((r) => r.name === selected) ?? null,
    [rows, archivedRows, selected],
  )
  const isArchivedSel = selRow !== null && !rows.some((r) => r.name === selRow.name)

  const clusterDot = useCallback(
    (id: string | null) => clusters.find((c) => c.id === id)?.dotClass ?? 'bg-rule',
    [clusters],
  )
  const clusterName = (id: string | null): string => clusters.find((c) => c.id === id)?.name ?? 'Unclustered'

  const select = useCallback((name: string | null) => {
    setSelected(name)
    setMode('read')
    setFix(IDLE_FIX)
    setAppliedSlug(null)
    setOverlay(null)
  }, [])

  const goView = useCallback((v: ExplorerView) => {
    setView(v)
    setQuery('')
    setOverlay(null)
    setFix(IDLE_FIX)
    setMode((m) => (m === 'edit' || m === 'new' ? 'read' : m))
  }, [])

  // Keep a valid selection: first row when nothing (or something that vanished) is selected.
  useEffect(() => {
    if (ex.loading || !isBrowse || mode === 'new') return
    if (selRow && listRows.some((r) => r.name === selRow.name)) return
    setSelected(listRows[0]?.name ?? null)
  }, [ex.loading, isBrowse, mode, selRow, listRows])

  // Load file content for the selected row; live-sync reloads it but never touches the editor draft.
  const readName = selRow && !isArchivedSel ? selRow.name : null
  const readStamp = selRow?.mtimeMs
  useEffect(() => {
    if (!readName) return
    let live = true
    void actions.read(readName).then((text) => { if (live) setLoaded({ name: readName, text }) })
    return () => { live = false }
  }, [readName, readStamp, actions.read]) // eslint-disable-line react-hooks/exhaustive-deps

  const content = isArchivedSel ? '' : loaded && loaded.name === readName ? loaded.text : null

  // `/` opens the palette unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase() ?? ''
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
      if (t?.closest?.('.monaco-editor')) return
      e.preventDefault()
      setOverlay('palette')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const say = (message: string, undoFn?: () => void) => setUndo({ message, undo: undoFn })
  const openNew = (body = '') => {
    if (noMemory) return
    if (view === 'ask' || view === 'clusters') setView('all')
    setSelected(null)
    setTitle('')
    setDraft(body)
    setDraftOrig('')
    setFix(IDLE_FIX)
    setOverlay(null)
    setMode('new')
  }

  const openByName = (name: string) => { goView('all'); select(name) }
  const openBySlug = (slug: string) => {
    const r = rows.find((x) => x.slug === slug)
    if (r) select(r.name)
    else toast.error(`${slug} is not in this scope`)
  }

  const startEdit = () => {
    if (content === null) return
    const body = stripFront(content)
    setDraft(body)
    setDraftOrig(body)
    setMode('edit')
  }

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      if (mode === 'new') {
        const name = await actions.create(title, draft)
        if (!name) return
        const file = name.endsWith('.md') ? name : `${name}.md`
        goView('all')
        select(file)
        say(`Created ${stem(file)}`)
      } else if (mode === 'edit' && selRow) {
        const ok = await actions.saveBody(selRow.name, draft)
        if (!ok) return
        setMode('read')
        say(`Saved ${selRow.slug}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = () => {
    setMode('read')
    if (!selRow) setSelected(null)
  }

  const runFix = async () => {
    if (!selRow || content === null) return
    const row = selRow
    setFix({ ...IDLE_FIX, state: 'checking' })
    const r = await actions.proposeFix(row.name)
    if (!r.ok) { setFix(IDLE_FIX); return }
    setProposed(r.content)
    setFix({
      state: 'proposed',
      diff: r.action === 'update' ? lineDiff(content, r.content) : [],
      summary: r.summary,
      action: r.action,
      reason: r.reason,
      fold: r.fold,
    })
  }

  const applyFix = async () => {
    if (!selRow || content === null) return
    const row = selRow
    if (fix.action === 'delete') {
      if (!(await actions.archive(row.name))) return
      setFix(IDLE_FIX)
      say(`Archived ${row.slug}`, () => { void actions.restore(row.name) })
    } else if (fix.action === 'keep') {
      if (!(await actions.verify(row.name))) return
      setFix(IDLE_FIX)
      say(`Marked ${row.slug} verified`)
    } else if (fix.action === 'fold') {
      if (!fix.fold) return
      const { target, anchor, insert } = fix.fold
      const text =
        `Fold memory ${row.slug} into ${target}.\n` +
        `Insert after the line: ${anchor || '(append at end)'}\n---\n${insert}\n---\n` +
        `Tread lightly: add only these lines, do not restructure the doc. ` +
        `Once committed, archive the memory ${row.slug} from the Memory page.\n` +
        `Memory file: ${row.path}`
      const r = await window.api.clipboard.writeText(text)
      if (!r.ok) { toast.error(`Copy failed: ${r.error ?? 'unknown error'}`); return }
      setFix(IDLE_FIX)
      say('Fold copied — paste it into a New Epic')
    } else {
      const before = stripFront(content)
      const ok = await actions.saveBody(row.name, stripFront(proposed))
      if (!ok) return
      setFix(IDLE_FIX)
      setAppliedSlug(row.slug)
      say(`Applied fix to ${row.slug}`, () => { void actions.saveBody(row.name, before) })
    }
  }

  const verify = async () => {
    if (!selRow) return
    const row = selRow
    if (await actions.verify(row.name)) say(`Marked ${row.slug} verified`)
  }

  const archive = async () => {
    if (!selRow) return
    const row = selRow
    setOverlay(null)
    if (await actions.archive(row.name)) say(`Archived ${row.slug}`, () => { void actions.restore(row.name) })
  }

  const restore = async () => {
    if (!selRow) return
    const row = selRow
    if (await actions.restore(row.name)) say(`Restored ${row.slug}`)
  }

  const confirmDelete = async () => {
    if (!selRow) return
    const row = selRow
    setOverlay(null)
    const undoFn = await actions.remove(row.name)
    if (!undoFn) return
    const n = row.inLinks.length
    say(`Deleted ${row.slug}${n > 0 ? ` · ${n} inbound links now broken` : ''}`, () => { void undoFn() })
  }

  const copyPath = async () => {
    if (!selRow) return
    const r = await window.api.clipboard.writeText(selRow.path)
    if (r.ok) say('Path copied')
    else toast.error(`Copy failed: ${r.error ?? 'unknown error'}`)
  }

  const reveal = () => {
    if (selRow) void window.api.shell.open({ as: 'revealPath', path: selRow.path })
  }

  const removeLink = async (slug: string) => {
    if (!selRow) return
    const row = selRow
    if (await actions.removeLink(row.name, slug)) say(`Dead link removed from ${row.slug}`)
  }

  const askAbout = () => {
    if (!selRow) return
    setAskCtx(selRow.slug)
    goView('ask')
  }

  const ctxName = (slug: string | null): string | undefined =>
    slug ? rows.find((r) => r.slug === slug)?.name ?? `${slug}.md` : undefined

  const counts = useMemo(() => navCounts(rows), [rows])
  const clusterCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const r of rows) if (r.clusterId) out[r.clusterId] = (out[r.clusterId] ?? 0) + 1
    return out
  }, [rows])
  const unclusteredCount = useMemo(() => rows.filter((r) => r.clusterId === null).length, [rows])
  const known = useMemo(() => new Set(rows.map((r) => r.slug)), [rows])

  const listTitle = view.startsWith('cluster:')
    ? view === 'cluster:unclustered' ? 'Unclustered' : clusters.find((c) => c.id === view.slice(8))?.name ?? 'Cluster'
    : ({ all: 'All memories', stale: 'Stale', broken: 'Broken references', recent: 'Changed this week', unindexed: 'Not in index', archived: 'Archived' } as Record<string, string>)[view] ?? 'All memories'

  let empty: { title: string; body: string; action: string; onAction: () => void } | null = null
  if (listRows.length === 0) {
    if (noMemory) {
      empty = {
        title: `${scopeName} has no persistent memory`,
        body: 'Add `memory: project` (or user/local) to its frontmatter in the Agent Library to turn it on.',
        action: 'Back to workspace',
        onAction: () => onScope({ kind: 'workspace' }),
      }
    } else if (query.trim()) {
      empty = {
        title: `No memories match “${query}”`,
        body: 'Filter checks names and descriptions in this view.',
        action: 'Clear filter',
        onAction: () => setQuery(''),
      }
    } else if (rows.length === 0 && view === 'all') {
      empty = {
        title: `${scopeName} has no memories yet`,
        body: 'They appear when this subagent saves one, or add one now.',
        action: '+ New memory',
        onAction: () => openNew(NEW_TEMPLATE),
      }
    } else {
      empty = {
        title: 'All clear',
        body: view === 'stale' ? 'Nothing is stale in this scope.' : 'Nothing in this view.',
        action: 'Back to all memories',
        onAction: () => goView('all'),
      }
    }
  }

  const autoOff = !ex.autoMemoryEnabled
  const learn = LEARNING_CONTENT.memory

  return (
    <div data-testid="mx-shell" className="relative h-full flex flex-col bg-bg text-fg leading-[normal]">
      <div className="relative shrink-0 flex items-center gap-3 px-6 py-4 border-b border-rule-structural">
        <div className="flex items-baseline gap-3 pt-1">
          <span className="text-[11px] tracking-[.08em] font-medium text-fg-dim">CONFIGURE</span>
          <span className="font-serif text-[28px] leading-none">Memory</span>
          <span className="text-xs text-fg-dim">Claude Code's own memory files · stored on this machine</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="mx-search-trigger"
          onClick={() => setOverlay('palette')}
          className="flex items-center gap-2 h-[30px] px-2.5 border border-rule-structural rounded-md bg-bg-elev w-[300px] text-xs text-fg-dim hover:border-fg-faint"
        >
          <span>Search all memories, or ask a question…</span>
          <span className="flex-1" />
          <span className="font-mono text-[10px] px-[5px] py-px border border-rule-structural rounded-[3px] text-fg-dim">/</span>
        </button>
        <button
          type="button"
          data-testid="mx-learn"
          onClick={() => setOverlay((o) => (o === 'learn' ? null : 'learn'))}
          className={`text-[11px] tracking-[.08em] font-semibold px-1 py-1.5 hover:text-fg ${overlay === 'learn' ? 'text-fg' : 'text-accent'}`}
        >
          LEARN
        </button>
        {overlay === 'learn' && (
          <div
            data-testid="mx-learn-popover"
            className={`absolute right-5 top-[58px] w-[360px] ${Z.dialog} bg-bg-hi border border-rule-structural rounded-lg shadow-2xl p-4 flex flex-col gap-2.5 text-[13px] leading-[1.55] text-fg`}
          >
            <span className="font-serif text-[17px]">How memory works</span>
            <span>{learn.intro}</span>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="mx-learn-close"
                onClick={() => setOverlay(null)}
                className="text-xs font-medium h-7 px-3 rounded-[5px] bg-fg text-bg"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </div>

      {autoOff && (
        <div data-testid="mx-auto-off" className="shrink-0 w-full px-6 py-2 bg-butter/40 text-honey-dark text-[12.5px]">
          Auto memory is off — Claude Code is not reading or writing any of these files.
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <ExplorerNav
          scope={scope}
          agents={ex.agents}
          agentCounts={ex.agentCounts}
          workspaceName={basename(cwd)}
          workspacePath={cwd ?? ''}
          workspaceCount={agent ? wsCount : rows.length}
          onScope={onScope}
          view={view}
          onView={goView}
          counts={counts}
          clusters={clusters}
          clusterCounts={clusterCounts}
          unclusteredCount={unclusteredCount}
          archivedCount={ex.archived.length}
          index={ex.index}
        />
        <main className="flex-1 min-w-0 min-h-0 flex">
          {view === 'ask' && (
            <div className="flex-1 min-w-0">
              <AskView
                rows={rows}
                context={askCtx}
                onClearContext={() => setAskCtx(null)}
                onAsk={(q, ctx) => actions.ask(q, ctxName(ctx))}
                onOpen={openByName}
                onReverify={() => goView('stale')}
                onDraft={(text) => openNew(text)}
              />
            </div>
          )}
          {view === 'clusters' && (
            <ClustersView
              clusters={clusters}
              rows={rows}
              generatedAt={ex.clustersMeta.generatedAt}
              running={ex.clustersMeta.running}
              unclusteredCount={unclusteredCount}
              available={!agent}
              onRegenerate={() => { void actions.regenerateClusters() }}
              onOpenCluster={(id) => goView(`cluster:${id}`)}
              onOpen={openByName}
            />
          )}
          {isBrowse && (
            <div className="flex-1 min-w-0 min-h-0 grid grid-cols-[316px_minmax(0,1fr)_236px]">
              <MemoryListPane
                title={listTitle}
                rows={listRows}
                clusterDot={clusterDot}
                selected={selected}
                onSelect={select}
                query={query}
                onQuery={setQuery}
                sort={sort}
                onSort={setSort}
                onNew={() => openNew(NEW_TEMPLATE)}
                empty={empty}
              />
              <div className="flex flex-col min-w-0 min-h-0">
                {mode === 'edit' || mode === 'new' ? (
                  <MemoryEditorPane
                    mode={mode}
                    name={selRow?.slug ?? null}
                    title={title}
                    onTitle={setTitle}
                    body={draft}
                    onBody={setDraft}
                    onSave={() => { void save() }}
                    onCancel={cancelEdit}
                    saving={saving}
                    dirty={mode === 'new' ? title.trim() !== '' || draft !== NEW_TEMPLATE : draft !== draftOrig}
                  />
                ) : selRow ? (
                  <MemoryReader
                    row={selRow}
                    content={content}
                    clusterName={clusterName(selRow.clusterId)}
                    clusterDot={clusterDot(selRow.clusterId)}
                    archived={isArchivedSel}
                    mode={mode}
                    onMode={setMode}
                    onEdit={startEdit}
                    onCopyPath={() => { void copyPath() }}
                    onReveal={reveal}
                    onArchive={() => { void archive() }}
                    onRestore={() => { void restore() }}
                    onAskDelete={() => setOverlay('delete')}
                    fix={fix}
                    appliedStill={appliedSlug === selRow.slug && selRow.stale}
                    onFix={() => { void runFix() }}
                    onApplyFix={() => { void applyFix() }}
                    onDiscardFix={() => setFix(IDLE_FIX)}
                    onVerify={() => { void verify() }}
                  />
                ) : (
                  <MemoryEditorPane
                    mode="none"
                    name={null}
                    title=""
                    onTitle={setTitle}
                    body=""
                    onBody={setDraft}
                    onSave={() => {}}
                    onCancel={() => {}}
                    saving={false}
                    dirty={false}
                  />
                )}
              </div>
              <LinksRail
                row={isArchivedSel || mode === 'new' ? null : selRow}
                known={known}
                onOpen={openBySlug}
                onRemoveLink={(slug) => { void removeLink(slug) }}
                onAskAbout={askAbout}
              />
            </div>
          )}
        </main>
      </div>

      <SearchPalette
        open={overlay === 'palette'}
        rows={rows}
        clusterDot={clusterDot}
        onPick={openByName}
        onAsk={() => { setAskCtx(null); goView('ask') }}
        onClose={() => setOverlay(null)}
      />
      <DeleteMemoryDialog
        open={overlay === 'delete' && selRow !== null}
        name={selRow?.slug ?? ''}
        inbound={selRow?.inLinks.length ?? 0}
        onArchive={() => { void archive() }}
        onCancel={() => setOverlay(null)}
        onConfirm={() => { void confirmDelete() }}
      />
      <UndoBar
        message={undo?.message ?? null}
        onUndo={undo?.undo ? () => { const u = undo.undo; setUndo(null); u?.() } : undefined}
        onClose={() => setUndo(null)}
      />
    </div>
  )
}
