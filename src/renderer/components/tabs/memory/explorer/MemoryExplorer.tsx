import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '../../../../state/toast'
import { useConfigSearchFocus } from '../../../../state/configSearchFocus'
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
import { MemoryListPane, type ScopeOption } from './MemoryListPane'
import { MemoryReader } from './MemoryReader'
import { MemoryEditorPane } from './MemoryEditorPane'
import { LinksRail } from './LinksRail'
import { AskView } from './AskView'
import { ClustersView } from './ClustersView'
import { DeleteMemoryDialog } from './DeleteMemoryDialog'
import { UndoBar } from './UndoBar'
import { ACTION_UI, type Suggestion } from './MemorySuggestionCard'

const SCOPE_LS_KEY = 'sm.memoryTab.scope'
const AGENT_PREFIX = 'agent:'

type Mode = 'read' | 'edit' | 'new'
type Overlay = 'delete' | null
interface Fix extends Suggestion {
  state: 'idle' | 'checking' | 'proposed'
  /** Wall time of the check, measured here in the renderer. */
  elapsedMs: number
}
interface UndoMsg { message: string; undo?: () => void }

const NEW_TEMPLATE = 'One-line summary of the fact or rule.\n\n**Why:**\n\n**How to apply:**'
const IDLE_FIX: Fix = { state: 'idle', diff: [], summary: '', action: 'update', reason: '', fold: null, elapsedMs: 0 }
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Only facts the proposeFix result itself carries — never inferred ones. */
function evidenceOf(fix: Fix): string[] {
  const out = [`Verdict: ${ACTION_UI[fix.action].label.toLowerCase()}`]
  if (fix.action === 'update') {
    const removed = fix.diff.filter((d) => d.sign === '−').length
    const added = fix.diff.filter((d) => d.sign === '+').length
    out.push(`${plural(removed, 'line')} removed · ${plural(added, 'line')} added`)
  }
  if (fix.action === 'fold' && fix.fold) {
    out.push(`${plural(fix.fold.insert.split('\n').length, 'line')} into ${fix.fold.target}`)
    out.push(fix.fold.anchor ? `After: ${fix.fold.anchor}` : 'Appended at the end')
  }
  return out
}
const stem = (s: string): string => s.replace(/\.md$/, '')
const basename = (p: string | null): string => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : 'workspace')

function stripFront(src: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  return (m ? src.slice(m[0].length) : src).replace(/^\s*\n/, '')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rewrite every backticked `from` (optionally `from:<line>`) to `to`, keeping the line suffix. */
function rewriteMovedPath(body: string, from: string, to: string): string {
  return body.replace(new RegExp('`' + escapeRe(from) + '(:\\d+)?`', 'g'), (_m, line: string | undefined) => '`' + to + (line ?? '') + '`')
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

  // A "Search all config" memory pick names a workspace memory file: show the workspace scope so
  // the body (which selects the file and clears the request) can find it.
  const focusTab = useConfigSearchFocus((st) => st.tab)
  useEffect(() => {
    if (focusTab === 'memory' && scopeKey !== 'workspace') onScope({ kind: 'workspace' })
  }, [focusTab, scopeKey, onScope])

  return (
    <ExplorerBody
      key={scopeKey}
      scope={scope}
      cwd={cwd}
      onScope={onScope}
      onAgents={onAgents}
    />
  )
}

interface BodyProps {
  scope: ExplorerScope
  cwd: string | null
  onScope: (s: ExplorerScope) => void
  onAgents: (a: MemoryAgent[]) => void
}

function ExplorerBody({ scope, cwd, onScope, onAgents }: BodyProps) {
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
  const [suggestEdit, setSuggestEdit] = useState(false)
  const [appliedSlug, setAppliedSlug] = useState<string | null>(null)
  const [undo, setUndo] = useState<UndoMsg | null>(null)
  const [askCtx, setAskCtx] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [draftOrig, setDraftOrig] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState<{ name: string; text: string | null } | null>(null)

  useEffect(() => { onAgents(ex.agents) }, [ex.agents, onAgents])

  const archivedRows = useMemo<MemoryRow[]>(
    () => ex.archived.map((name) => ({
      name, slug: stem(name), path: `${ex.dir}/${name}`, description: '', bytes: 0, mtimeMs: 0, ageDays: 0,
      stale: false, staleReasons: [], ageOnlyStale: false, deadRefs: [], movedRefs: [], broken: false, danglingLinks: [],
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
    setSuggestEdit(false)
    setFix(IDLE_FIX)
    setAppliedSlug(null)
    setOverlay(null)
  }, [])

  const goView = useCallback((v: ExplorerView) => {
    setView(v)
    setQuery('')
    setOverlay(null)
    setFix(IDLE_FIX)
    setSuggestEdit(false)
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

  // Edit opens the whole file as it is on disk; Save writes it back verbatim.
  const startEdit = () => {
    if (content === null) return
    setDraft(content)
    setDraftOrig(content)
    setSuggestEdit(false)
    setMode('edit')
  }

  // Edit first: Claude's proposed file is the unsaved value; the file on disk is the baseline the editor marks against.
  const editFirst = () => {
    if (content === null || fix.state !== 'proposed' || fix.action !== 'update') return
    setDraft(proposed)
    setDraftOrig(content)
    setSuggestEdit(true)
    setMode('edit')
  }

  const editDirty = mode === 'edit' && draft !== draftOrig

  // A "Search all config" pick for this tab (`memory:<path>`): once the workspace list has
  // loaded, open that file in the All view (an unsaved edit asks first). A miss keeps the
  // selection. Either way the request is consumed; an agent scope waits for the shell's switch.
  const focusTab = useConfigSearchFocus((st) => st.tab)
  const focusId = useConfigSearchFocus((st) => st.id)
  const clearFocus = useConfigSearchFocus((st) => st.clear)
  useEffect(() => {
    if (focusTab !== 'memory' || !focusId || agent || ex.loading) return
    const path = focusId.startsWith('memory:') ? focusId.slice('memory:'.length) : null
    const row = path ? rows.find((r) => r.path === path) : undefined
    if (row && (!editDirty || window.confirm('Discard unsaved changes to this memory?'))) {
      goView('all')
      select(row.name)
    }
    clearFocus()
  }, [focusTab, focusId, agent, ex.loading, rows, editDirty, goView, select, clearFocus])

  const revertEdit = async () => {
    if (!selRow) return
    const current = await actions.read(selRow.name)
    if (current === null) return
    setDraft(current)
    setDraftOrig(current)
    setSuggestEdit(false)
  }

  const leaveEdit = () => {
    if (editDirty && !window.confirm('Discard unsaved changes to this memory?')) return
    setSuggestEdit(false)
    setMode('read')
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
        const row = selRow
        const before = draftOrig
        const fromClaude = suggestEdit
        const ok = await actions.saveFile(row.name, draft)
        if (!ok) return
        setMode('read')
        setSuggestEdit(false)
        if (fromClaude) {
          setFix(IDLE_FIX)
          setAppliedSlug(row.slug)
          say(`Applied edited fix to ${row.slug}`, () => { void actions.saveFile(row.name, before) })
        } else {
          say(`Saved ${row.slug}`)
        }
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
    const t0 = performance.now()
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
      elapsedMs: performance.now() - t0,
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
      // Undo restores the file byte-for-byte as it was on disk before Apply.
      const before = content
      const ok = await actions.saveBody(row.name, stripFront(proposed))
      if (!ok) return
      setFix(IDLE_FIX)
      setAppliedSlug(row.slug)
      say(`Applied fix to ${row.slug}`, () => { void actions.saveFile(row.name, before) })
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

  const updatePath = async (ref: { from: string; to: string }) => {
    if (!selRow) return
    const row = selRow
    try {
      const current = await actions.read(row.name)
      if (current === null) return
      const before = stripFront(current)
      const next = rewriteMovedPath(before, ref.from, ref.to)
      if (next === before) {
        toast.error(`${ref.from} is not referenced in backticks in ${row.slug}`)
        await actions.refresh()
        return
      }
      // saveBody refreshes list + stale data on success and toasts on failure.
      if (!(await actions.saveBody(row.name, next))) return
      say(`Updated ${ref.from} → ${ref.to} in ${row.slug}`, () => { void actions.saveBody(row.name, before) })
    } catch (e) {
      toast.error(`Path update failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const askAbout = () => {
    if (!selRow) return
    setAskCtx(selRow.slug)
    goView('ask')
  }

  const ctxName = (slug: string | null): string | undefined =>
    slug ? rows.find((r) => r.slug === slug)?.name ?? `${slug}.md` : undefined

  const check = useMemo(
    () => (fix.state === 'proposed' ? { elapsedMs: fix.elapsedMs, evidence: evidenceOf(fix) } : null),
    [fix],
  )

  const counts = useMemo(() => navCounts(rows), [rows])
  const unclusteredCount = useMemo(() => rows.filter((r) => r.clusterId === null).length, [rows])
  const known = useMemo(() => new Set(rows.map((r) => r.slug)), [rows])
  const scopeOptions = useMemo<ScopeOption[]>(
    () => [
      { key: 'workspace', label: `Workspace · ${basename(cwd)}` },
      ...ex.agents.map((a) => ({ key: `${AGENT_PREFIX}${a.name}`, label: `Subagent · ${a.name}${a.memoryScope ? '' : ' (off)'}` })),
    ],
    [ex.agents, cwd],
  )
  const scopeKey = agent ? `${AGENT_PREFIX}${agent.name}` : 'workspace'
  const onScopeKey = useCallback((key: string) => {
    const a = key.startsWith(AGENT_PREFIX) ? ex.agents.find((x) => x.name === key.slice(AGENT_PREFIX.length)) : undefined
    onScope(a ? { kind: 'agent', agent: a } : { kind: 'workspace' })
  }, [ex.agents, onScope])

  const listTitle = view.startsWith('cluster:')
    ? view === 'cluster:unclustered' ? 'Unclustered' : clusters.find((c) => c.id === view.slice(8))?.name ?? 'Cluster'
    : ({ all: 'All memories', ask: 'Ask', clusters: 'Clusters', stale: 'Stale', broken: 'Broken references', recent: 'Changed this week', unindexed: 'Not in index', archived: 'Archived' } as Record<string, string>)[view] ?? 'All memories'

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

  return (
    <div data-testid="mx-shell" className="relative h-full flex flex-col bg-bg text-fg leading-[normal]">
      {autoOff && (
        <div data-testid="mx-auto-off" className="shrink-0 w-full px-6 py-2 bg-butter/40 text-honey-dark text-[12.5px]">
          Auto memory is off — Claude Code is not reading or writing any of these files.
        </div>
      )}

      <div
        className={`flex-1 min-h-0 grid ${isBrowse ? 'grid-cols-[316px_minmax(0,1fr)_268px]' : 'grid-cols-[316px_minmax(0,1fr)]'}`}
      >
        <MemoryListPane
          title={listTitle}
          rows={isBrowse ? listRows : []}
          clusterDot={clusterDot}
          selected={selected}
          onSelect={select}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          onNew={() => openNew(NEW_TEMPLATE)}
          empty={isBrowse ? empty : null}
          folder={{ count: rows.length, path: ex.dir }}
          scopeOptions={scopeOptions}
          scopeKey={scopeKey}
          onScopeKey={onScopeKey}
          view={view}
          onView={goView}
          counts={counts}
          clusterCount={clusters.length}
          archivedCount={ex.archived.length}
        />
        {view === 'ask' && (
          <div className="min-w-0 min-h-0 flex">
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
          </div>
        )}
        {view === 'clusters' && (
          <div className="min-w-0 min-h-0 flex">
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
          </div>
        )}
        {isBrowse && (
          <>
              <div className="flex flex-col min-w-0 min-h-0">
                {mode === 'new' ? (
                  <MemoryEditorPane
                    mode="new"
                    name={null}
                    title={title}
                    onTitle={setTitle}
                    body={draft}
                    onBody={setDraft}
                    onSave={() => { void save() }}
                    onCancel={cancelEdit}
                    saving={saving}
                    dirty={title.trim() !== '' || draft !== NEW_TEMPLATE}
                  />
                ) : selRow ? (
                  <MemoryReader
                    row={selRow}
                    content={content}
                    clusterName={clusterName(selRow.clusterId)}
                    clusterDot={clusterDot(selRow.clusterId)}
                    archived={isArchivedSel}
                    editing={mode === 'edit'}
                    editingSuggestion={mode === 'edit' && suggestEdit}
                    editor={mode === 'edit' ? (
                      <MemoryEditorPane
                        mode="edit"
                        name={selRow.slug}
                        path={selRow.path}
                        title=""
                        onTitle={setTitle}
                        body={draft}
                        onBody={setDraft}
                        onSave={() => { void save() }}
                        onCancel={leaveEdit}
                        onRevert={() => { void revertEdit() }}
                        changedFrom={suggestEdit ? draftOrig : undefined}
                        saving={saving}
                        dirty={editDirty}
                      />
                    ) : undefined}
                    onRead={leaveEdit}
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
                    onEditFirst={editFirst}
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
                onUpdatePath={(ref) => { void updatePath(ref) }}
                onReviewPath={() => { void runFix() }}
                onAskAbout={askAbout}
                onCheck={() => { void runFix() }}
                checkBusy={fix.state !== 'idle' || content === null}
                editing={mode === 'edit'}
                editingSuggestion={mode === 'edit' && suggestEdit}
                check={mode === 'edit' ? null : check}
              />
          </>
        )}
      </div>

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
