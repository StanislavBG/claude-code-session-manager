import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ConfigCard } from '../../claudeConfig/ConfigLayout'
import { DocumentEditorPane } from '../editor/DocumentEditorPane'
import { useHomeDir } from '../../../lib/useHomeDir'
import { useModelCatalog } from '../../../lib/useModelCatalog'
import { useAgentCliDetect } from '../../../lib/useAgentCliDetect'
import { compactPath } from '../../../lib/compactPath'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { TAG_LIBRARY } from '../../../lib/tagLibrary'
import { ticketTagTone } from '../../../lib/ticketDisplay'
import { readUiSettingsPrefs, writeUiSettingsPrefs } from '../../../lib/uiSettingsPrefs'
import { toKnownTags } from '../../../lib/personaSavePayload'
import { toast } from '../../../state/toast'
import { Z } from '../../../lib/zLayers'
import type { AgentPersona } from '../../../../preload/api'
import {
  COLORS, COLOR_SWATCH, TOOLS, MoreMenu, RowLabel, ModelSelect, EffortSelect, RunsOnSelect,
  ProjectOverrideBlock, overrideChipText, toDraft, type Draft, type OpenProject,
} from './AgentDetail'
import { loadoutOf, type LoadoutState } from './AgentRoster'

/**
 * Agent character sheet — frame 1b "workbench" (DESIGN_SPEC.md): a collapsible agent list column (a
 * 64 px avatar rail by default, the 316 px list when expanded — deviation 1), and the sheet itself:
 * header (avatar, name, loadout badge + counts, `edited`, class line + tags, Global | In project,
 * Duplicate, ⋯), DESCRIPTION, STATS, PERSONALITY & GROUNDING preview (Open editor = the shared
 * DocumentEditorPane, full screen), a right column with the Gear / Constraints slots (their contents
 * are sibling PRDs) and THIS LOADOUT APPLIES TO, and the bottom save bar. Save / revert / delete /
 * duplicate go through the same AgentLibrary handlers and IPC calls as before.
 */

export function avatarColor(c: string | null): string {
  if (!c) return '#8a7a60'
  return COLOR_SWATCH[c] ?? (c.startsWith('#') ? c : '#8a7a60')
}

const STATE_DOT: Record<LoadoutState, string> = { undecided: '#d3a23c', equipped: '#6f7d52', bare: '#9a9a9a', unbound: '#a3441f' }
const STATE_LABEL: Record<LoadoutState, string> = { undecided: 'Undecided', equipped: 'Equipped', bare: 'Bare', unbound: 'Unbound' }
const EFFORT_PIPS = ['low', 'medium', 'high', 'xhigh', 'max']

function Avatar({ name, color, size }: { name: string; color: string | null; size: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center rounded-full font-serif font-semibold text-white shrink-0"
      style={{ width: size, height: size, background: avatarColor(color), fontSize: Math.round(size * 0.45) }}
    >
      {(name[0] ?? '?').toUpperCase()}
    </span>
  )
}

// ---- list column: rail / expanded, persisted ----------------------------------------------------

/** The list column's expanded flag: collapsed until the persisted choice (machine-wide UI prefs) loads. */
export function useAgentsListExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(false)
  const touched = useRef(false)
  useEffect(() => {
    let cancelled = false
    void readUiSettingsPrefs().then((p) => {
      if (!cancelled && !touched.current && typeof p.agentsListExpanded === 'boolean') setExpanded(p.agentsListExpanded)
    })
    return () => { cancelled = true }
  }, [])
  const toggle = () => {
    touched.current = true
    const next = !expanded
    setExpanded(next)
    writeUiSettingsPrefs({ agentsListExpanded: next }).catch(() => toast.error("Couldn't save the agent list layout."))
  }
  return [expanded, toggle]
}

/** Rail of avatar letters (persona colour, loadout-state dot, selected ring); name on hover / aria-label. */
function AgentRail({ personas, selectedName, onPick }: { personas: readonly AgentPersona[]; selectedName: string | null; onPick: (name: string) => void }) {
  return (
    <nav data-testid="agent-rail" aria-label="Agents" className="flex flex-col items-center gap-2">
      {personas.map((p) => {
        const state = loadoutOf(p)
        const selected = p.name === selectedName
        return (
          <button
            key={p.name}
            type="button"
            data-agent-rail={p.name}
            data-loadout={state}
            aria-label={`${p.name} — ${STATE_LABEL[state]}`}
            aria-current={selected ? 'true' : undefined}
            title={p.name}
            onClick={() => onPick(p.name)}
            className={`relative rounded-full p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-line'}`}
          >
            <Avatar name={p.name} color={p.color} size={36} />
            <span
              data-testid="agent-rail-dot"
              aria-hidden="true"
              className="absolute right-0 bottom-0 w-2.5 h-2.5 rounded-full border-2 border-bg-elev"
              style={{ background: STATE_DOT[state] }}
            />
          </button>
        )
      })}
    </nav>
  )
}

/** The sheet's two-column frame: list column (rail by default) + detail. `list` is the expanded content. */
export function AgentWorkbench({ expanded, onToggle, list, personas, selectedName, onPick, detail }: {
  expanded: boolean
  onToggle: () => void
  list: ReactNode
  personas: readonly AgentPersona[]
  selectedName: string | null
  onPick: (name: string) => void
  detail: ReactNode
}) {
  return (
    <div data-testid="config-workbench" className="flex flex-1 min-h-0 min-w-0">
      <div
        data-testid="agent-list-column"
        data-expanded={expanded ? 'true' : 'false'}
        className={`${expanded ? 'w-[316px] px-4' : 'w-16 px-2 items-center'} shrink-0 bg-bg-elev border-r border-line py-[18px] flex flex-col gap-3 overflow-y-auto`}
      >
        <button
          type="button"
          data-testid="agent-list-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse agent list' : 'Expand agent list'}
          title={expanded ? 'Collapse agent list' : 'Expand agent list'}
          onClick={onToggle}
          className={`h-7 min-w-7 px-1.5 inline-flex items-center justify-center rounded-md border border-line bg-bg-hi text-fg-dim hover:text-fg ${expanded ? 'self-end' : ''}`}
        >
          {expanded ? '«' : '»'}
        </button>
        {expanded ? list : <AgentRail personas={personas} selectedName={selectedName} onPick={onPick} />}
      </div>
      <div data-testid="config-workbench-detail" className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto">
        {detail}
      </div>
    </div>
  )
}

// ---- the sheet ----------------------------------------------------------------------------------

/** Right-column placeholder for the Gear card — the gear PRD replaces this body (it keeps today's tool chips meanwhile). */
export function GearSlot({ obj, set }: { obj: Draft; set: (patch: Partial<Draft>) => void }) {
  const allTools = obj.tools.length === 0
  const toggleTool = (t: string) => {
    if (allTools) { set({ tools: TOOLS.filter((x) => x !== t) }); return }
    set({ tools: obj.tools.includes(t) ? obj.tools.filter((x) => x !== t) : [...obj.tools, t] })
  }
  return (
    <section data-testid="agent-gear-slot" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">
        Gear <span className="font-serif italic normal-case tracking-normal font-normal text-fg-dim">what it can reach</span>
      </div>
      <div className="flex items-start gap-3" data-testid="agent-tools-row">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap gap-1.5">
            {TOOLS.map((t) => {
              const on = allTools || obj.tools.includes(t)
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  data-tool={t}
                  onClick={() => toggleTool(t)}
                  className={`px-2 py-0.5 rounded-md text-[12px] font-mono border ${
                    on ? 'bg-honey/20 text-honey-dark border-honey/40' : 'bg-transparent text-fg-faint border-dashed border-rule'
                  }`}
                >
                  {t}
                </button>
              )
            })}
          </div>
          <div data-testid="agent-tools-note" className="text-[11px] text-fg-faint mt-1 leading-snug">
            {allTools ? (
              'All tools — no tools: line, so every tool (MCP included) is granted. Click one to restrict.'
            ) : (
              <>
                {obj.tools.length} of {TOOLS.length} granted. Anything not filled is refused at call time.{' '}
                <button type="button" data-testid="agent-tools-all" onClick={() => set({ tools: [] })} className="underline text-fg-dim hover:text-fg">
                  Grant all tools
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Right-column placeholder for the Constraints card — the constraints PRD fills it. */
export function ConstraintsSlot() {
  return (
    <section data-testid="agent-constraints-slot" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-dashed border-line text-[12px] text-fg-faint">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em]">Constraints</div>
      <div className="mt-1 italic">Sandbox, risk marks and banned tools appear here.</div>
    </section>
  )
}

function AppliesToCard() {
  const rows: Array<[string, string]> = [['Epic chat', 'the chat opens as this agent'], ['Scheduler jobs', 'PRDs with this agentType'], ['Tasks', 'headless runs that name it']]
  return (
    <section data-testid="agent-applies-to" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">This loadout applies to</div>
      <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-fg">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-baseline gap-2"><span className="font-medium">{k}</span><span className="text-[11.5px] text-fg-faint">{v}</span></li>
        ))}
      </ul>
      <div className="mt-2 text-[11.5px] text-fg-faint italic">Changes apply to new sessions</div>
    </section>
  )
}

const FIELD_LABELS: Array<[keyof Draft, string]> = [
  ['name', 'name'], ['description', 'description'], ['tools', 'tools'], ['model', 'model'], ['effort', 'effort'],
  ['color', 'colour'], ['tags', 'tags'], ['body', 'personality'], ['agentCli', 'runs on'], ['agentCliModel', 'CLI model'],
]

/** Changed field labels of the draft against the saved persona (a new draft: every field is new). */
export function changedFields(obj: Draft, saved: AgentPersona | null, isNew: boolean): string[] {
  if (isNew || !saved) return ['new agent']
  const base = toDraft(saved)
  return FIELD_LABELS.filter(([k]) => JSON.stringify(obj[k]) !== JSON.stringify(base[k])).map(([, l]) => l)
}

export function AgentSheet({
  obj, set, saved, dirty, isNew, busy, confirmDelete, setConfirmDelete,
  onDuplicate, onRevert, onSave, onDelete, onDropOverride, projects, selected, onSelect, onSaveOverride,
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
  onDropOverride: (cwd: string, label: string) => void
  /** PROJECT OVERRIDE picker: every open project, the chosen one (null = none), and the chooser. */
  projects: OpenProject[]
  selected: OpenProject | null
  onSelect: (cwd: string | null) => void
  onSaveOverride: (patch: { model: string; effort: string }) => void
}) {
  const home = useHomeDir()
  const { catalog, loading: catalogLoading, degraded, refresh: refreshCatalog } = useModelCatalog(null)
  const { checking: cliChecking, recheck: recheckClis } = useAgentCliDetect()
  const [addingOverride, setAddingOverride] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const path = !isNew && saved ? saved.path : `${home ?? '~'}/.claude/agents/${obj.name}.md`
  const canRevertOrSave = dirty || isNew
  const overrides = saved && !isNew ? saved.overrideDetails ?? [] : []
  const showOverridePicker = !isNew && !!saved && (addingOverride || selected !== null)
  const changes = canRevertOrSave ? changedFields(obj, saved, isNew) : []
  const state: LoadoutState = saved && !isNew ? loadoutOf(saved) : 'undecided'
  const servers = new Set(obj.tools.map((t) => /^mcp__(.+?)__/.exec(t)?.[1]).filter(Boolean)).size
  const builtins = obj.tools.filter((t) => t !== '*' && !t.startsWith('mcp__')).length
  const counts = obj.tools.length === 0 ? 'every tool' : `${builtins} tools${servers ? ` · ${servers} server${servers > 1 ? 's' : ''}` : ''}`

  useEffect(() => {
    if (!editorOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setEditorOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editorOpen])

  const catalogInfo = catalog
    ? `Models live-read from claude${catalog.claudeVersion ? ` ${catalog.claudeVersion}` : ''}${degraded ? ' (cached — CLI probe unavailable)' : ''}`
    : catalogLoading ? 'Loading model catalog…' : 'Model catalog unavailable — showing the standard list'
  const menuItems = [
    {
      label: catalogLoading || cliChecking ? 'Re-checking…' : 'Re-check models & CLIs',
      testId: 'agent-detail-recheck',
      disabled: catalogLoading || cliChecking,
      onSelect: () => { void refreshCatalog(); void recheckClis() },
    },
    { label: catalogInfo, testId: 'agent-detail-catalog-info', disabled: true, info: true, onSelect: () => {} },
    { label: 'Reveal in File Explorer', testId: 'agent-detail-reveal', disabled: isNew, onSelect: () => revealInFileExplorer(path) },
    ...(!isNew ? [{ label: 'Delete agent…', testId: 'agent-detail-delete', danger: true, disabled: busy, onSelect: () => setConfirmDelete(true) }] : []),
  ]

  const overrideNote = overrides.length === 0
    ? (isNew ? 'save first to see project overrides.' : 'no open project overlays this agent — the global definition applies everywhere.')
    : overrides.length === 1
      ? `a local copy in ${compactPath(overrides[0].cwd, home)}/.claude/agents/ wins there`
      : "each project's local copy in its .claude/agents/ wins there"

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (canRevertOrSave && !busy) onSave()
    }
  }

  const inProject = showOverridePicker
  const previewLines = obj.body.split('\n').slice(0, 9).join('\n')

  return (
    <div data-testid="agent-sheet" onKeyDown={onKeyDown} className="flex-1 shrink-0 min-h-full flex flex-col">
      <div data-testid="agent-detail" className="flex-1 shrink-0 flex flex-col">
        <header data-testid="config-detail-header" className="shrink-0 px-9 pt-6 pb-4 flex items-start gap-4 border-b border-line">
          <Avatar name={obj.name} color={obj.color || null} size={56} />
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-[22px] font-semibold text-fg font-mono truncate">{obj.name}</h1>
              <span
                data-testid="agent-loadout-badge"
                data-loadout={state}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-line bg-bg-hi text-[11px] text-fg-dim"
              >
                <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: STATE_DOT[state] }} />
                {STATE_LABEL[state]} · {counts}
              </span>
              {(isNew || dirty) && (
                <span data-testid="config-detail-pill" className="px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[11px] font-semibold">
                  {isNew ? 'unsaved draft' : 'edited'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[13px]">
              <span className="font-serif italic text-fg-dim">{obj.description.split(/[.—]/)[0].trim() || 'No description yet'}</span>
              {toKnownTags(obj.tags).map((t) => {
                const tone = ticketTagTone(t)
                return <span key={t} className={`px-2 py-0.5 rounded-full text-[11px] font-mono ${tone.bg} ${tone.text}`}>#{t}</span>
              })}
            </div>
            <div className="text-[11px] text-fg-faint font-mono truncate">AGENT · USER · {compactPath(path, home)}</div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <div role="group" aria-label="Scope" data-testid="agent-scope-switch" className="inline-flex items-center p-0.5 rounded bg-bg-hi border border-line">
              {(['Global', 'In project'] as const).map((label) => {
                const on = (label === 'In project') === inProject
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    disabled={label === 'In project' && (isNew || !saved)}
                    onClick={() => {
                      if (label === 'In project') setAddingOverride(true)
                      else { setAddingOverride(false); onSelect(null) }
                    }}
                    className={`px-2.5 py-1 text-[12px] rounded disabled:opacity-40 ${on ? 'bg-bg text-fg font-medium shadow-sm' : 'text-fg-dim hover:text-fg'}`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              onClick={onDuplicate}
              disabled={busy}
              className="h-9 px-4 rounded-[10px] bg-bg-hi border border-line text-[13.5px] font-medium text-fg hover:border-rule disabled:opacity-40"
            >
              Duplicate
            </button>
            <MoreMenu items={menuItems} />
          </div>
        </header>
        {confirmDelete && (
          <div
            data-testid="agent-detail-delete-confirm"
            role="alert"
            className="shrink-0 mx-9 mt-4 px-4 py-2.5 rounded-[10px] border border-red-400/40 bg-red-400/10 flex items-center gap-3 text-[13px] text-fg"
          >
            <span className="flex-1 min-w-0">Delete <strong className="font-mono">{obj.name}</strong> and its file?</span>
            <button type="button" onClick={onDelete} disabled={busy} className="font-semibold text-red-400 hover:text-red-300">Delete</button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="text-fg-faint hover:text-fg">Keep</button>
          </div>
        )}

        <div data-testid="agent-detail-body" className="flex-1 shrink-0 grid grid-cols-[minmax(0,1fr)_340px] gap-4 px-9 py-6 items-start">
          <div className="flex flex-col gap-4 min-w-0">
            <ConfigCard label="DESCRIPTION" labelNote="CLAUDE READS THIS TO PICK THE AGENT">
              <textarea
                data-testid="agent-detail-description"
                aria-label="Description"
                rows={2}
                value={obj.description}
                // A description is one frontmatter line: Enter never inserts a break.
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                onChange={(e) => set({ description: e.target.value.replace(/\r?\n/g, ' ') })}
                placeholder="What this agent does — Claude reads it to decide when to use it"
                className="w-full resize-none bg-transparent outline-none text-fg placeholder:text-fg-faint"
              />
            </ConfigCard>

            <section data-testid="agent-runtime-card" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">Stats</div>
              <div data-testid="agent-runtime-row" className="grid grid-cols-3 gap-4">
                <ModelSelect value={obj.model} onChange={(v) => set({ model: v })} />
                <EffortSelect value={obj.effort} model={obj.model} onChange={(v) => set({ effort: v })} />
                <div className="min-w-0 flex flex-col gap-1.5">
                  <RunsOnSelect value={obj.agentCli} onChange={(id) => set({ agentCli: id, agentCliModel: '' })} />
                  {obj.agentCli !== 'claude' && (
                    <input
                      data-testid="agent-persona-cli-model"
                      aria-label="CLI model"
                      value={obj.agentCliModel}
                      maxLength={128}
                      placeholder="Blank = the CLI's own default"
                      onChange={(e) => set({ agentCliModel: e.target.value })}
                      className="w-full bg-bg border border-line rounded-md px-2 py-1 text-xs text-fg font-mono"
                    />
                  )}
                </div>
              </div>
              <div data-testid="agent-effort-pips" aria-hidden="true" className="flex items-center gap-1">
                {EFFORT_PIPS.map((l, i) => (
                  <span key={l} className={`w-1.5 h-1.5 rounded-full ${i <= EFFORT_PIPS.indexOf(obj.effort) ? 'bg-fg-dim' : 'bg-line'}`} />
                ))}
              </div>
            </section>

            <section className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-4">
              <div className="flex items-start gap-3" data-testid="agent-overrides-row">
                <RowLabel>project overrides</RowLabel>
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2 pt-0.5">
                  {overrides.map((d) => (
                    <span
                      key={d.cwd}
                      data-testid="agent-override-chip"
                      title={`${compactPath(d.cwd, home)}/.claude/agents/${saved!.name}.md`}
                      className="inline-flex items-center gap-1.5 bg-bg-elev border border-line rounded-md px-2 py-0.5 text-[12px] font-mono text-fg-dim"
                    >
                      <strong className="font-sans font-semibold text-fg">{d.project}</strong>
                      {overrideChipText(d)}
                      <button onClick={() => onDropOverride(d.cwd, d.project)} title="Drop the local copy" className="text-fg-faint hover:text-fg">×</button>
                    </span>
                  ))}
                  <span className={`text-[12px] text-fg-faint ${overrides.length === 0 ? 'italic' : ''}`}>{overrideNote}</span>
                  {!isNew && saved && !showOverridePicker && (
                    <button type="button" data-testid="agent-override-add" onClick={() => setAddingOverride(true)} className="text-[12px] font-medium text-accent hover:underline">
                      + Add override
                    </button>
                  )}
                </div>
              </div>
              {showOverridePicker && saved && (
                <ProjectOverrideBlock
                  saved={saved}
                  projects={projects}
                  selected={selected}
                  onSelect={onSelect}
                  busy={busy}
                  onSave={onSaveOverride}
                  onClose={() => { setAddingOverride(false); onSelect(null) }}
                />
              )}

              {/* Name / colour / tags: still editable, folded away. A new draft opens it (its name is the one thing it must set). */}
              <details data-testid="agent-details" open={isNew || undefined} className="group border-t border-line pt-3">
                <summary className="cursor-pointer select-none flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">
                  <span>details</span>
                  <span className="normal-case tracking-normal font-normal font-mono text-fg-dim flex items-center gap-1.5">
                    {obj.color && <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COLOR_SWATCH[obj.color] }} />}
                    {obj.color || 'no colour'} · {obj.tags.length ? obj.tags.map((t) => `#${t}`).join(' ') : 'no tags'}
                  </span>
                </summary>
                <div className="flex flex-col gap-3 pt-3">
                  <div className="flex items-start gap-3">
                    <RowLabel>name</RowLabel>
                    <div className="flex-1 min-w-0">
                      <input
                        data-testid="agent-detail-name"
                        aria-label="Name"
                        value={obj.name}
                        onChange={(e) => set({ name: e.target.value.toLowerCase() })}
                        className="w-full max-w-sm bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
                      />
                      <div className="text-[11px] text-fg-faint mt-1 leading-snug">Filename on disk — lowercase, hyphenated.</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <RowLabel>color</RowLabel>
                    <div className="flex gap-1.5 pt-0.5">
                      {COLORS.map((c) => (
                        <button
                          key={c || 'none'}
                          type="button"
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
                  </div>
                  <div className="flex items-start gap-3">
                    <RowLabel>tags</RowLabel>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap gap-1.5">
                        {TAG_LIBRARY.map((t) => {
                          const on = obj.tags.includes(t.tag)
                          const tone = ticketTagTone(t.tag)
                          return (
                            <button
                              key={t.tag}
                              type="button"
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
                      <div className="text-[11px] text-fg-faint mt-1 leading-snug">
                        Session mission tags this persona is associated with — shown as the default agent on the Tags tab.
                      </div>
                    </div>
                  </div>
                </div>
              </details>
            </section>

            <section data-testid="agent-personality" data-busy={busy ? 'true' : undefined} className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">
                  Personality &amp; grounding <span className="font-serif italic normal-case tracking-normal font-normal text-fg-dim">the persona body</span>
                </span>
                <button
                  type="button"
                  data-testid="agent-open-editor"
                  onClick={() => setEditorOpen(true)}
                  className="h-8 px-3 rounded-[10px] bg-bg border border-line text-[12.5px] font-medium text-fg hover:border-rule"
                >
                  Open editor
                </button>
              </div>
              <pre data-testid="agent-personality-preview" className="mt-2 max-h-44 overflow-hidden whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg-dim">
                {previewLines || 'No personality text yet.'}
              </pre>
            </section>
          </div>

          <div className="flex flex-col gap-4 min-w-0">
            <GearSlot obj={obj} set={set} />
            <ConstraintsSlot />
            <AppliesToCard />
          </div>
        </div>

        <div
          data-testid="agent-save-bar"
          role="status"
          className="sticky bottom-0 shrink-0 px-9 py-3 flex items-center gap-3 border-t border-line bg-bg-elev text-[13px]"
        >
          <span data-testid="agent-save-summary" className="flex-1 min-w-0 truncate text-fg-dim">
            {canRevertOrSave
              ? `${changes.length} unsaved change${changes.length === 1 ? '' : 's'} · ${changes.join(', ')} · applies to new sessions only`
              : 'No unsaved changes'}
          </span>
          <button
            type="button"
            data-testid="agent-revert"
            onClick={onRevert}
            disabled={!canRevertOrSave || busy}
            className="h-9 px-4 rounded-[10px] bg-bg-hi border border-line font-medium text-fg hover:border-rule disabled:opacity-40"
          >
            Revert
          </button>
          <button
            type="button"
            data-testid="agent-save"
            onClick={() => { if (!busy) onSave() }}
            disabled={!canRevertOrSave || busy}
            className="h-9 px-4 rounded-[10px] bg-accent text-white font-semibold disabled:opacity-40"
          >
            Save <span className="font-normal opacity-80 text-[11px]">Ctrl S</span>
          </button>
        </div>
      </div>

      {editorOpen && (
        <div
          data-testid="agent-detail-editor"
          data-busy={busy ? 'true' : undefined}
          role="dialog"
          aria-label={`Edit ${obj.name} personality`}
          className={`fixed inset-0 ${Z.dialog} flex flex-col bg-bg`}
        >
          <div className="flex items-center gap-3 px-4 h-11 shrink-0 border-b border-line bg-bg-elev">
            <span className="flex-1 min-w-0 truncate text-[12px] font-mono text-fg-dim">{compactPath(path, home)}</span>
            <button type="button" data-testid="agent-editor-close" onClick={() => setEditorOpen(false)} className="px-3 py-1 rounded-md border border-line text-[12.5px] text-fg hover:bg-bg-hi">
              Done
            </button>
          </div>
          <div className="flex-1 min-h-0 grid">
            <DocumentEditorPane
              path={path}
              value={obj.body}
              defaultMode="document"
              dirty={canRevertOrSave}
              isNew={isNew}
              onChange={(body) => set({ body })}
              onSave={() => { if (!busy) onSave() }}
              onRevert={onRevert}
            />
          </div>
        </div>
      )}
    </div>
  )
}
