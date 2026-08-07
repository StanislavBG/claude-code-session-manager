import { memo, useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { toast } from '../../state/toast'
import type { AgentPersona, AgentPersonaSaveInput } from '../../../preload/api'
import { TAG_LIBRARY } from '../../lib/tagLibrary'
import { ticketTagTone } from '../../lib/ticketDisplay'
import { takePendingPersonaName } from '../../lib/agentLibraryDeepLink'

/**
 * Agent Library — list+detail editor over `~/.claude/agents/*.md` personas.
 * Follows Skills.tsx's canonical list+detail shape (component-local fetch on
 * mount, filterable sidebar, detail pane) plus real CRUD: New/Duplicate/Save/
 * Revert/Delete write straight through to disk via `window.api.agents.*`
 * (agentLibrary.cjs), scoped to the global persona directory only — a
 * project's local overlay at `<cwd>/.claude/agents/<name>.md` can be dropped
 * here (`removeOverride`) but never created, since this page has no per-tab
 * cwd context of its own (it's a Home-face, machine-wide surface).
 *
 * The "tags" field assigns/removes Epic intent tags (TAG_LIBRARY) on this
 * persona — a `tags:` frontmatter line persisted alongside `tools`/`model`.
 * Tag Library's detail pane reads/writes the same field from the other side
 * (which agents carry a given tag), so the relationship is a single source
 * of truth no matter which page you edit it from.
 */

const MODELS = ['inherit', 'haiku', 'sonnet', 'opus'] as const
const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']
const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
const COLOR_SWATCH: Record<string, string> = {
  red: '#c0392b', orange: '#b85c34', yellow: '#c9a227', green: '#6f7d52',
  cyan: '#3f8f8a', blue: '#4a6fa5', purple: '#7a6a8a', pink: '#b45a80',
}

interface Draft {
  name: string
  description: string
  tools: string[]
  model: string
  color: string
  tags: string[]
  body: string
}

function toDraft(p: AgentPersona): Draft {
  return {
    name: p.name,
    description: p.description ?? '',
    tools: p.tools,
    model: p.model ?? 'inherit',
    color: p.color ?? '',
    tags: p.tags,
    body: p.body,
  }
}

const BLANK_DRAFT: Draft = { name: 'new-agent', description: '', tools: ['Read', 'Grep'], model: 'inherit', color: '', tags: [], body: '' }

function AgentLibraryComponent() {
  const [personas, setPersonas] = useState<AgentPersona[] | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [rowConfirmDelete, setRowConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = async (selectAfter?: string) => {
    try {
      const list = await window.api.agents.listPersonas()
      if (!mounted.current) return
      setPersonas(list)
      setSelectedName((cur) => selectAfter ?? cur ?? list[0]?.name ?? null)
    } catch (e) {
      if (!mounted.current) return
      setPersonas([])
      toast.error((e as Error).message || 'failed to load agent personas')
    }
  }

  useEffect(() => { load() }, [])
  // Tag Library writes to the same persona files (assign/unassign a tag from
  // its own side) — refresh here too so this panel never shows a stale
  // snapshot if it's already mounted when that happens.
  useEffect(() => window.api.agents.onChanged(() => load()), [])

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

  if (personas === null) return <EmptyState title="loading…" />

  const needle = filter.toLowerCase()
  const filtered = personas.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle),
  )
  const saved = personas.find((p) => p.name === selectedName) ?? personas[0] ?? null
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
      const payload: AgentPersonaSaveInput = {
        name: obj.name,
        originalName: isNew ? undefined : saved?.name,
        description: obj.description,
        tools: obj.tools,
        model: obj.model,
        color: obj.color,
        tags: obj.tags,
        body: obj.body,
      }
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

  const dropOverride = async (projectName: string) => {
    if (!saved) return
    try {
      await window.api.agents.removeOverride({ name: saved.name, projectName })
      toast.info(`removed ${projectName}'s override of ${saved.name}`)
      await load(saved.name)
    } catch (e) {
      toast.error((e as Error).message || 'failed to remove override')
    }
  }

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">
            {personas.length} persona{personas.length === 1 ? '' : 's'}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg w-40"
          />
          <div className="flex-1" />
          <Button variant="primary" onClick={create}>+ New agent</Button>
        </>
      }
    >
      <ListDetail
        sidebar={
          <div className="py-1">
            {isNew && (
              <div className="w-full text-left px-3 py-1 text-xs flex flex-col gap-0.5 bg-bg-hi text-fg border-l-2 border-accent">
                <span className="flex items-center gap-2 justify-between w-full">
                  <span className="truncate font-mono">{obj?.name}</span>
                  <span className="shrink-0 text-[10px] font-semibold text-accent">new</span>
                </span>
              </div>
            )}
            {filtered.length === 0 && !isNew ? (
              <div className="px-3 py-1 text-xs text-fg-faint italic">no agent personas found</div>
            ) : (
              filtered.map((p) => {
                const isSelected = !isNew && p.name === selectedName
                const isDirty = isSelected && dirty
                const confirming = rowConfirmDelete === p.name
                return (
                  <div
                    key={p.name}
                    data-agent-row={p.name}
                    className={`group w-full text-left px-3 py-1 text-xs flex flex-col gap-0.5 border-l-2 cursor-pointer ${
                      isSelected
                        ? 'bg-bg-hi text-fg border-accent'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-hi border-transparent'
                    }`}
                    onClick={() => pick(p.name)}
                  >
                    <span className="flex items-center gap-2 justify-between w-full">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-2 h-2 rounded-sm shrink-0"
                          style={{ background: p.color ? COLOR_SWATCH[p.color] ?? p.color : 'var(--fg-faint, #999)', opacity: p.color ? 1 : 0.35 }}
                        />
                        <span className="truncate font-mono">{p.name}</span>
                      </span>
                      <span className="shrink-0 flex items-center gap-1.5">
                        {isDirty && <span className="text-[10px] font-semibold text-accent">unsaved</span>}
                        {!isDirty && p.overridingProjects.length > 0 && (
                          <Badge tone="dim">{p.overridingProjects.length} override{p.overridingProjects.length > 1 ? 's' : ''}</Badge>
                        )}
                        {confirming ? (
                          <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => removeRow(p.name)}
                              disabled={busy}
                              title={`Delete ${p.name}`}
                              className="text-[10px] font-semibold text-red-400 hover:text-red-300"
                            >
                              confirm
                            </button>
                            <button
                              onClick={() => setRowConfirmDelete(null)}
                              title="Cancel"
                              className="text-[10px] text-fg-faint hover:text-fg"
                            >
                              cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setRowConfirmDelete(p.name) }}
                            title={`Delete ${p.name}`}
                            className="opacity-0 group-hover:opacity-100 text-fg-faint hover:text-red-400 transition-opacity"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    </span>
                    {p.description && <span className="truncate text-fg-faint">{p.description}</span>}
                  </div>
                )
              })
            )}
          </div>
        }
        detail={
          obj ? (
            <AgentPersonaEditor
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
            />
          ) : (
            <EmptyState title="select an agent" />
          )
        }
      />
    </Panel>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const AgentLibrary = memo(AgentLibraryComponent)

function AgentPersonaEditor({
  obj, set, saved, dirty, isNew, busy, confirmDelete, setConfirmDelete,
  onDuplicate, onRevert, onSave, onDelete, onDropOverride,
}: {
  obj: Draft
  set: (patch: Partial<Draft>) => void
  saved: AgentPersona | null
  dirty: boolean
  isNew: boolean
  busy: boolean
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  onDuplicate: () => void
  onRevert: () => void
  onSave: () => void
  onDelete: () => void
  onDropOverride: (projectName: string) => void
}) {
  const path = `~/.claude/agents/${obj.name}.md`
  const canRevertOrSave = dirty || isNew
  return (
    <div className="max-w-3xl">
      <div className="px-4 py-3 border-b border-line flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-fg font-mono">{obj.name}</span>
        {isNew ? <Badge tone="accent">unsaved draft</Badge> : dirty ? <Badge tone="warn">edited</Badge> : <Badge tone="good">saved</Badge>}
        <span className="ml-auto text-[11px] text-fg-faint font-mono">{path}</span>
      </div>

      <div className="p-4 space-y-4">
        <Field label="name" hint="Filename on disk — lowercase, hyphenated.">
          <input
            value={obj.name}
            onChange={(e) => set({ name: e.target.value.toLowerCase() })}
            className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
          />
        </Field>

        <Field label="description" hint="Shown in the list and in agent pickers.">
          <input
            value={obj.description}
            onChange={(e) => set({ description: e.target.value })}
            className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg"
          />
        </Field>

        <Field
          label="default model"
          hint="This persona's default model for its Epics — sets the --model an Epic launches with (Terminal + Chat both honor it). 'inherit' falls back to each view's own default, not this Settings page. Cheap models for read-only personas; opus for judgement calls."
        >
          <Choice options={MODELS as unknown as string[]} value={obj.model} onChange={(v) => set({ model: v })} mono />
        </Field>

        <Field label="tools" hint={`${obj.tools.length} of ${TOOLS.length} granted. Anything not ticked is refused at call time.`}>
          <div className="flex flex-wrap gap-1.5">
            {TOOLS.map((t) => {
              const on = obj.tools.includes(t)
              return (
                <button
                  key={t}
                  onClick={() => set({ tools: on ? obj.tools.filter((x) => x !== t) : [...obj.tools, t] })}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-mono border ${
                    on ? 'bg-sage/15 text-sage-dark border-sage/30' : 'bg-bg-hi text-fg-faint border-line'
                  }`}
                >
                  {t}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="color">
          <div className="flex gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c || 'none'}
                title={c || 'none'}
                onClick={() => set({ color: c })}
                className="w-5 h-5 rounded"
                style={{
                  background: c ? COLOR_SWATCH[c] : 'transparent',
                  border: obj.color === c ? '2px solid var(--accent, #b85c34)' : '1px solid var(--line, #555)',
                }}
              />
            ))}
          </div>
        </Field>

        <Field label="tags" hint="Epic intent tags this persona is associated with — shown as the default agent on that tag's own page.">
          <div className="flex flex-wrap gap-1.5">
            {TAG_LIBRARY.map((t) => {
              const on = obj.tags.includes(t.tag)
              const tone = ticketTagTone(t.tag)
              return (
                <button
                  key={t.tag}
                  onClick={() => set({ tags: on ? obj.tags.filter((x) => x !== t.tag) : [...obj.tags, t.tag] })}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-mono border ${
                    on ? `${tone.bg} ${tone.text} ${tone.border ? 'border-current/30' : 'border-transparent'}` : 'bg-bg-hi text-fg-faint border-line'
                  }`}
                >
                  #{t.tag}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="definition" hint="The system prompt this persona runs under.">
          <textarea
            rows={9}
            value={obj.body}
            onChange={(e) => set({ body: e.target.value })}
            className="w-full bg-bg border border-line rounded px-2 py-1.5 text-xs text-fg font-mono leading-relaxed resize-y"
          />
        </Field>

        <Field label="project overrides" hint="Open projects that shadow this definition with a local copy.">
          {saved && saved.overridingProjects.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {saved.overridingProjects.map((p) => (
                <span key={p} className="inline-flex items-center gap-1.5 bg-bg-elev border border-line rounded px-2 py-0.5 text-[11px] font-mono text-fg-dim">
                  {p}
                  <button onClick={() => onDropOverride(p)} title="Drop the local copy" className="text-fg-faint hover:text-fg">×</button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-fg-faint italic">
              {isNew ? 'save first to see project overrides.' : 'no open project overlays this agent — the global definition applies everywhere.'}
            </div>
          )}
        </Field>
      </div>

      <div className="px-4 py-2.5 border-t border-line flex items-center gap-2 flex-wrap">
        {confirmDelete ? (
          <>
            <span className="text-xs text-fg-dim">Delete <strong className="font-mono">{obj.name}</strong> and its file?</span>
            <Button variant="danger" onClick={onDelete} disabled={busy}>Delete</Button>
            <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
          </>
        ) : (
          <>
            <Button onClick={onDuplicate} disabled={busy}>Duplicate</Button>
            {!isNew && <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>}
            <div className="flex-1" />
            {canRevertOrSave && <span className="text-[11px] text-fg-faint">unsaved changes</span>}
            <Button onClick={onRevert} disabled={!canRevertOrSave || busy}>Revert</Button>
            <Button variant="primary" onClick={onSave} disabled={!canRevertOrSave || busy}>
              {busy ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint mb-1.5 font-mono">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-fg-faint mt-1 leading-snug">{hint}</div>}
    </div>
  )
}

function Choice({ options, value, onChange, mono }: { options: string[]; value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = o === value
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`px-2.5 py-1 rounded text-xs border ${mono ? 'font-mono' : ''} ${
              on ? 'bg-accent/15 text-accent border-accent/40 font-semibold' : 'bg-bg-hi text-fg-dim border-line'
            }`}
          >
            {o}
          </button>
        )
      })}
    </div>
  )
}
