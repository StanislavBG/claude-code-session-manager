import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Badge } from '../ui/Badge'
import { ConfigFileCard, ConfigListRow, ConfigListToolbar, ConfigWorkbench } from '../claudeConfig/ConfigLayout'
import { TagLibrary } from './TagLibrary'
import { AgentRoster } from './agents/AgentRoster'
import { AgentDetail, BLANK_DRAFT, overrideParts, toDraft, type Draft, type OpenProject } from './agents/AgentDetail'
import { toast } from '../../state/toast'
import type { AgentPersona, AgentPersonaSaveInput } from '../../../preload/api'
import { toKnownTags, toPersonaSaveInput } from '../../lib/personaSavePayload'
import { takePendingPersonaName } from '../../lib/agentLibraryDeepLink'
import { useAgentPersonasState } from '../../lib/useAgentPersonas'
import { useAgentsDirWatch } from '../../lib/useAgentsDirWatch'
import { useSessions } from '../../state/sessions'
import { useConfigSearchFocus } from '../../state/configSearchFocus'
import { normalizeCwd, projectNameFromCwd } from '../../lib/knownProjectAggregate'

/**
 * Agent Library — list+detail editor over `~/.claude/agents/*.md` personas,
 * on the claude-config ConfigLayout kit (render 15): AGENTS FOLDER card (which also
 * carries the Personas | Tags switch — DESIGN_SPEC.md §5.3), Filter + '+ New', one row per agent (name, model, description); the detail
 * lives in ./agents/AgentDetail.tsx. Component-local fetch, real CRUD: New/Duplicate/Save/
 * Revert/Delete write straight through to disk via `window.api.agents.*`
 * (agentLibrary.cjs), scoped to the global persona directory.
 *
 * Per-project overrides: this is a Home-face, machine-wide page, so it never
 * reads the active tab — no open project is special. The PROJECT OVERRIDES
 * row's '+ Add override' opens a PROJECT OVERRIDE block that carries an explicit project picker listing every open project
 * (one entry per unique tab cwd, nothing preselected); choosing one shows and
 * writes that project's frontmatter-only overlay at
 * `<cwd>/.claude/agents/<name>.md`, keyed by the chosen cwd. Any open
 * project's overlay can also be dropped from the "project overrides" chips
 * (`removeOverride`).
 *
 * The "tags" field assigns/removes session intent tags (TAG_LIBRARY) on this
 * persona — a `tags:` frontmatter line persisted alongside `tools`/`model`.
 * The Tags tab (TagLibrary, read-only) shows the other side of that
 * relationship; this editor is the only place the field is written.
 *
 * Existing `projects:`/`action:`/`actionLabel:` frontmatter (legacy persona Actions,
 * migrated once into the machine-local Macro library and no longer rendered
 * from the persona) is no longer editable here; saves pass it through untouched.
 */

/** One entry per unique `normalizeCwd(tab.cwd)` (so `/a/b/` and `/a/b` are one), sorted by name then cwd. */
function openProjectsOf(tabs: readonly { cwd: string }[]): OpenProject[] {
  const byCwd = new Map<string, OpenProject>()
  for (const t of tabs) {
    const cwd = typeof t.cwd === 'string' ? normalizeCwd(t.cwd) : ''
    if (cwd && !byCwd.has(cwd)) byCwd.set(cwd, { cwd, name: projectNameFromCwd(cwd) })
  }
  return [...byCwd.values()].sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd))
}

/** Tooltip for the list's override badge: per project, which keys a frontmatter-only overlay sets, or "full body".
 *  One line per overrideDetails entry (one per open cwd), so two projects sharing a folder name stay two lines. */
function overrideSummary(p: AgentPersona): string {
  return (p.overrideDetails ?? [])
    .map((d) => `${d.project}: ${overrideParts(d).join(', ') || 'overlay'}`)
    .join('\n')
}

const VIEWS = [{ key: 'personas', label: 'Personas' }, { key: 'tags', label: 'Tags' }] as const

function AgentLibraryComponent() {
  const [view, setView] = useState<'personas' | 'tags'>('personas')
  const { personas, refresh } = useAgentPersonasState((e) => toast.error(e.message || 'failed to load agent personas'))
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [rowConfirmDelete, setRowConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  // Every open project, from the tab list — this Home-face page never reads which tab is active.
  // The selector returns the store's own array; the derived list is built in useMemo, never in it.
  const tabs = useSessions((s) => s.tabs)
  const openProjects = useMemo(() => openProjectsOf(tabs), [tabs])
  // The PROJECT OVERRIDE picker's choice: page state (survives switching personas), null on mount.
  const [overrideCwd, setOverrideCwd] = useState<string | null>(null)
  // Derived, so a closed tab falls back to "Choose a project…" with no effect.
  const overrideProject = openProjects.find((p) => p.cwd === overrideCwd) ?? null

  // Re-read after this page's own save; optionally select the saved persona.
  // (Mount + agents:changed refresh live in useAgentPersonasState.)
  const load = async (selectAfter?: string) => {
    const list = await refresh()
    if (list && selectAfter) setSelectedName(selectAfter)
  }

  // agents:changed only fires as a write-echo from this app's OWN save/delete
  // (agentLibrary.cjs) — an external edit to ~/.claude/agents/*.md (or any
  // open project's overlay dir) is otherwise invisible until the next
  // manual reload. Watch those directories directly and re-list on any
  // add/change/unlink, in addition to (not instead of) the echo above.
  useAgentsDirWatch(openProjects.map((p) => p.cwd), () => load())

  // Cross-tab deep link: EpicDetail's read-only Agent+model chip (PRD
  // agent-epic-readback) navigates here to jump straight to the persona a
  // given Epic is running as. takePendingPersonaName covers the common
  // case — this component wasn't mounted yet when the chip was clicked — by
  // checking once on mount; the listener below covers the case where Agent
  // Library was already open.
  useEffect(() => {
    const pendingName = takePendingPersonaName()
    if (pendingName) setSelectedName(pendingName)
    const h = (e: Event) => setSelectedName((e as CustomEvent<string>).detail)
    window.addEventListener('sm:select-persona', h)
    return () => window.removeEventListener('sm:select-persona', h)
  }, [])

  // A "Search all config" pick for this tab (`agents:<name>`): once the personas have
  // loaded, open the Personas view on that agent, clearing a filter that would hide it and
  // dropping any unsaved draft / new row. A miss keeps the selection. Either way the
  // request is consumed.
  const focusTab = useConfigSearchFocus((st) => st.tab)
  const focusId = useConfigSearchFocus((st) => st.id)
  const clearFocus = useConfigSearchFocus((st) => st.clear)
  useEffect(() => {
    if (focusTab !== 'agents' || !focusId || personas === null) return
    const name = focusId.startsWith('agents:') ? focusId.slice('agents:'.length) : null
    if (name && personas.some((p) => p.name === name)) {
      setView('personas')
      setFilter('')
      setDraft(null); setCreating(false); setConfirmDelete(false); setRowConfirmDelete(null)
      setSelectedName(name)
    }
    clearFocus()
  }, [focusTab, focusId, personas, clearFocus])

  // The Personas | Tags switch lives inside the AGENTS FOLDER card (DESIGN_SPEC.md §5.3), so the
  // card renders in both views; Tags swaps the list for nothing and the detail for TagLibrary.
  const folderCard = (
    <ConfigFileCard
      eyebrow="AGENTS FOLDER"
      badge={personas?.length}
      path="~/.claude/agents/"
      note="The actor a session opens with — “you are acting as …”"
    >
      {/* Same segmented pill as DocumentEditorPane's Document | Markdown switch. */}
      <div
        role="group"
        aria-label="Agents view"
        data-testid="agent-view-switch"
        className="mt-1 self-start inline-flex items-center p-0.5 rounded bg-bg-hi border border-line"
      >
        {VIEWS.map((v) => (
          <button
            type="button"
            key={v.key}
            onClick={() => setView(v.key)}
            aria-pressed={view === v.key}
            className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
              view === v.key ? 'bg-bg text-fg font-medium shadow-sm' : 'text-fg-dim hover:text-fg'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
    </ConfigFileCard>
  )
  if (view === 'tags') {
    return (
      <div className="flex flex-col h-full min-h-0">
        <ConfigWorkbench
          list={folderCard}
          detail={<TagLibrary onOpenPersona={(name) => { setSelectedName(name); setDraft(null); setCreating(false); setView('personas') }} />}
        />
      </div>
    )
  }

  if (personas === null) return <EmptyState title="loading…" />

  const needle = filter.toLowerCase()
  const filtered = personas.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle),
  )
  const saved = personas.find((p) => p.name === selectedName) ?? null
  const obj: Draft | null = draft ?? (saved ? toDraft(saved) : null)
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(toDraft(saved))
  const isNew = creating

  const pick = (name: string) => {
    setDraft(null); setCreating(false); setConfirmDelete(false); setRowConfirmDelete(null)
    setSelectedName(name)
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...(d ?? (saved ? toDraft(saved) : BLANK_DRAFT)), ...patch }))
  const create = () => { setDraft({ ...BLANK_DRAFT }); setCreating(true); setConfirmDelete(false) }
  const duplicate = () => {
    if (!obj) return
    setDraft({ ...obj, name: obj.name + '-copy' })
    setCreating(true)
  }
  const revert = () => { setDraft(null); setCreating(false) }

  const save = async () => {
    if (!obj) return
    if (!/^[a-z][a-z0-9-]*$/.test(obj.name)) {
      toast.error('agent name must be lowercase, hyphenated (e.g. "my-agent")')
      return
    }
    setBusy(true)
    try {
      const existing = isNew ? null : saved
      const editorFields: AgentPersonaSaveInput = {
        name: obj.name,
        originalName: existing?.name,
        description: obj.description,
        tools: obj.tools,
        model: obj.model,
        effort: obj.effort,
        color: obj.color,
        // Drop any tag that isn't in the closed WorkType union before sending — a persona
        // loaded with a stale/foreign tag (permitted on read) must not make every future save
        // of that persona fail agentPersonaSchema.cjs's validation.
        tags: toKnownTags(obj.tags),
        body: obj.body,
        // Always sent: 'claude' clears the agentCli: line. The model rides along only for a
        // non-Claude CLI with a non-blank value — the main-side schema rejects an empty one.
        agentCli: obj.agentCli,
        ...(obj.agentCli !== 'claude' && obj.agentCliModel.trim() ? { agentCliModel: obj.agentCliModel.trim() } : {}),
      }
      // savePersona rewrites the whole file, so an existing persona is the base: title and the
      // legacy projects/action/actionLabel keys (not editable here) pass through untouched.
      const payload: AgentPersonaSaveInput = existing ? toPersonaSaveInput(existing, editorFields) : editorFields
      // The editor owns agentCliModel: a cleared/Claude model must not be resurrected from the saved base.
      if (!('agentCliModel' in editorFields)) delete payload.agentCliModel
      await window.api.agents.savePersona(payload)
      toast.info(isNew ? `created ${obj.name}` : `saved ${obj.name}`)
      setDraft(null); setCreating(false)
      await load(obj.name)
    } catch (e) {
      toast.error((e as Error).message || 'failed to save agent persona')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!saved) return
    setBusy(true)
    try {
      await window.api.agents.deletePersona({ name: saved.name })
      toast.info(`deleted ${saved.name}`)
      setConfirmDelete(false); setDraft(null); setCreating(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'failed to delete agent persona')
    } finally {
      setBusy(false)
    }
  }

  const removeRow = async (name: string) => {
    setBusy(true)
    try {
      await window.api.agents.deletePersona({ name })
      toast.info(`deleted ${name}`)
      setRowConfirmDelete(null)
      if (selectedName === name) { setDraft(null); setCreating(false) }
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'failed to delete agent persona')
    } finally {
      setBusy(false)
    }
  }

  // `cwd` is an overrideDetails entry's key (its open project's cwd); `label` is only its folder name.
  const dropOverride = async (cwd: string, label: string) => {
    if (!saved) return
    try {
      await window.api.agents.removeOverride({ name: saved.name, projectCwd: cwd })
      toast.info(`removed ${label}'s override of ${saved.name}`)
      await load(saved.name)
    } catch (e) {
      toast.error((e as Error).message || 'failed to remove override')
    }
  }

  // Writes the CHOSEN project's frontmatter-only overlay through the same savePersona IPC (projectCwd
  // set = overlay, never the global file); clearing both keys drops the overlay via removeOverride.
  // Keyed by the picked project's normalized cwd, never its folder name (two open projects can share one).
  // A tab closed between render and click makes main throw ("project not open") → the toast below.
  const saveOverride = async (patch: { model: string; effort: string }) => {
    if (!saved || !overrideProject) return
    const { cwd: projectCwd, name: projectLabel } = overrideProject
    setBusy(true)
    try {
      if (patch.model === 'inherit' && patch.effort === 'inherit') {
        await window.api.agents.removeOverride({ name: saved.name, projectCwd })
        toast.info(`cleared ${projectLabel}'s override of ${saved.name}`)
      } else {
        await window.api.agents.savePersona({
          name: saved.name, projectCwd, description: '', tools: [], color: '', tags: [], body: '',
          model: patch.model, effort: patch.effort,
        })
        toast.info(`saved ${projectLabel}'s override of ${saved.name}`)
      }
      await load(saved.name)
    } catch (e) {
      toast.error((e as Error).message || 'failed to save project override')
    } finally {
      setBusy(false)
    }
  }

  // No agent selected (and not authoring a new one) = the roster landing.
  if (!selectedName && !creating) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <AgentRoster
          personas={personas}
          filter={filter}
          onFilterChange={setFilter}
          onOpen={(name) => pick(name)}
          onNew={create}
          view={view}
          onView={setView}
        />
      </div>
    )
  }

  const list = (
    <>
      {folderCard}
      <button
        type="button"
        data-testid="agent-back-to-roster"
        onClick={() => { setDraft(null); setCreating(false); setConfirmDelete(false); setRowConfirmDelete(null); setSelectedName(null) }}
        className="self-start text-[11px] text-fg-dim hover:text-fg"
      >
        ← All agents
      </button>
      <ConfigListToolbar filter={filter} onFilterChange={setFilter} placeholder="Filter" primaryLabel="+ New" onPrimary={create} />
      <div role="listbox" aria-label="Agents" className="flex flex-col gap-0.5">
        {isNew && obj && (
          <div data-agent-row-new="">
            <ConfigListRow
              title={obj.name}
              trailing={<span className="text-[10px] font-semibold text-accent">new</span>}
              meta={obj.description || undefined}
              selected
              onSelect={() => {}}
            />
          </div>
        )}
        {filtered.length === 0 && !isNew ? (
          <div className="px-3 py-1 text-xs text-fg-faint italic">no agent personas found</div>
        ) : (
          filtered.map((p) => {
            const isSelected = !isNew && p.name === saved?.name
            const isDirty = isSelected && dirty
            const confirming = rowConfirmDelete === p.name
            return (
              <div key={p.name} data-agent-row={p.name} className="group">
                <ConfigListRow
                  title={p.name}
                  selected={isSelected}
                  onSelect={() => pick(p.name)}
                  meta={p.description || undefined}
                  trailing={
                    <span className="flex items-center gap-1.5">
                      {isDirty && <span className="text-[10px] font-semibold text-accent">unsaved</span>}
                      {!isDirty && p.overridingProjects.length > 0 && (
                        <span title={overrideSummary(p)}>
                          <Badge tone="dim">{p.overridingProjects.length} override{p.overridingProjects.length > 1 ? 's' : ''}</Badge>
                        </span>
                      )}
                      <span data-testid="agent-row-model" className="font-mono">{p.model ?? 'inherit'}</span>
                      {confirming ? (
                        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => removeRow(p.name)}
                            disabled={busy}
                            title={`Delete ${p.name}`}
                            className="text-[10px] font-semibold text-red-400 hover:text-red-300"
                          >
                            confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setRowConfirmDelete(null)}
                            title="Cancel"
                            className="text-[10px] text-fg-faint hover:text-fg"
                          >
                            cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setRowConfirmDelete(p.name) }}
                          title={`Delete ${p.name}`}
                          aria-label={`Delete ${p.name}`}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-fg-faint hover:text-red-400 transition-opacity"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  }
                />
              </div>
            )
          })
        )}
      </div>
    </>
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <ConfigWorkbench
        list={list}
        detail={
          obj ? (
            <AgentDetail
              obj={obj}
              set={set}
              saved={saved}
              dirty={dirty}
              isNew={isNew}
              busy={busy}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDuplicate={duplicate}
              onRevert={revert}
              onSave={save}
              onDelete={remove}
              onDropOverride={dropOverride}
              projects={openProjects}
              selected={overrideProject}
              onSelect={setOverrideCwd}
              onSaveOverride={saveOverride}
            />
          ) : (
            <EmptyState title="select an agent" />
          )
        }
      />
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const AgentLibrary = memo(AgentLibraryComponent)
