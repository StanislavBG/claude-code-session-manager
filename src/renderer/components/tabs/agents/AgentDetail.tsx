import { useEffect, useId, useRef, useState } from 'react'
import { Badge } from '../../ui/Badge'
import { SourceChip } from '../../ui/SourceChip'
import { Choice } from '../../ui/Choice'
import { ConfigCard, ConfigDetailHeader } from '../../claudeConfig/ConfigLayout'
import { DocumentEditorPane } from '../editor/DocumentEditorPane'
import { useHomeDir } from '../../../lib/useHomeDir'
import { useModelCatalog } from '../../../lib/useModelCatalog'
import { modelFamily } from '../../../lib/prettyModel'
import { modelSupportsEffort } from '../../../lib/effortSupport'
import { MODELS, EFFORTS } from '../../../lib/agentRuntimeOptions'
import { compactPath } from '../../../lib/compactPath'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { TAG_LIBRARY } from '../../../lib/tagLibrary'
import { ticketTagTone } from '../../../lib/ticketDisplay'
import { Z } from '../../../lib/zLayers'
import { AgentCliPicker, type AgentCliChoice } from '../../epics/AgentCliPicker'
import type { AgentPersona } from '../../../../preload/api'

/**
 * Agent detail (claude-config design, render 15): eyebrow `AGENT · USER · <path>`, mono name,
 * Duplicate + `⋯` (Reveal, Delete agent…); the DESCRIPTION card Claude reads to pick the agent;
 * one card with MODEL / EFFORT / RUNS ON, TOOLS chips (allowed filled, others dashed) and the
 * PROJECT OVERRIDES chips (+ the per-project override picker); a NAME / COLOR / TAGS card; and
 * the persona body in the shared DocumentEditorPane (Document mode by default), whose status bar
 * owns Revert and Save for the whole draft. The frontmatter never enters the editor: the body is
 * `AgentPersona.body` (already split by main), and Save rebuilds the frontmatter from the draft's
 * fields plus the saved persona's pass-through keys — exactly as before this restyle.
 */

export const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']
const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
export const COLOR_SWATCH: Record<string, string> = {
  red: '#c0392b', orange: '#b85c34', yellow: '#c9a227', green: '#6f7d52',
  cyan: '#3f8f8a', blue: '#4a6fa5', purple: '#7a6a8a', pink: '#b45a80',
}

export interface Draft {
  name: string
  description: string
  tools: string[]
  model: string
  effort: string
  color: string
  // string[], not AgentPersonaTag[] — mirrors AgentPersona.tags (read path stays permissive;
  // a loaded persona may carry a stale/foreign tag). Filtered down to the known tags at
  // save time so the write-side schema (agentPersonaSchema.cjs's closed WorkType union) never
  // rejects a save just because the persona already had an unrecognized tag on disk.
  tags: string[]
  body: string
  /** Default coding-agent CLI New Session starts this persona on ('claude' = Claude Code, the default). */
  agentCli: AgentCliChoice
  /** Model for a non-Claude agentCli; '' = the CLI's own default. */
  agentCliModel: string
}

export function toDraft(p: AgentPersona): Draft {
  return {
    name: p.name,
    description: p.description ?? '',
    tools: p.tools,
    model: p.model ?? 'inherit',
    effort: p.effort ?? 'inherit',
    color: p.color ?? '',
    tags: p.tags,
    body: p.body,
    agentCli: p.agentCli ?? 'claude',
    agentCliModel: p.agentCliModel ?? '',
  }
}

export const BLANK_DRAFT: Draft = { name: 'new-agent', description: '', tools: ['Read', 'Grep'], model: 'inherit', effort: 'inherit', color: '', tags: [], body: '', agentCli: 'claude', agentCliModel: '' }

type OverrideDetail = NonNullable<AgentPersona['overrideDetails']>[number]

/** An open project the PROJECT OVERRIDE picker can target: a unique normalized tab cwd and its folder name. */
export interface OpenProject { cwd: string; name: string }

/** What one project's overlay of a persona overrides: its frontmatter keys (minus `name`), plus "full body". */
export function overrideParts(d: OverrideDetail): string[] {
  return [...d.fields.filter((f) => f !== 'name'), ...(d.bodyOverridden ? ['full body'] : [])]
}

/** Chip text after the project name: the overlay's model · effort values, else what it overrides. */
function overrideChipText(d: OverrideDetail): string {
  const vals = [d.values?.model, d.values?.effort].filter((v): v is string => !!v)
  if (d.bodyOverridden) vals.push('full body')
  if (vals.length) return vals.join(' · ')
  return overrideParts(d).join(', ') || 'overlay'
}

function MoreMenu({ items }: { items: ReadonlyArray<{ label: string; testId: string; danger?: boolean; disabled?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Close on Escape or a mousedown outside both the trigger and the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="agent-detail-more"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="h-9 w-9 inline-flex items-center justify-center rounded-[10px] bg-bg-hi border border-line text-fg-dim hover:text-fg hover:border-rule"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="More actions"
          data-testid="agent-detail-more-menu"
          className={`absolute ${Z.dialog} right-0 top-[42px] min-w-[200px] p-[5px] flex flex-col bg-bg-hi border border-line rounded-lg shadow-lg text-[13px] text-fg`}
        >
          {items.map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              data-testid={item.testId}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect() }}
              className={`px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev disabled:opacity-40 ${item.danger ? 'text-red-400' : ''}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Small uppercase label used for rows inside a card (TOOLS, PROJECT OVERRIDES, COLOR, TAGS). */
function RowLabel({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 w-[150px] text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint pt-1">{children}</span>
}

export function AgentDetail({
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
  const path = !isNew && saved ? saved.path : `${home ?? '~'}/.claude/agents/${obj.name}.md`
  const canRevertOrSave = dirty || isNew
  const overrides = saved && !isNew ? saved.overrideDetails ?? [] : []

  const menuItems = [
    { label: 'Reveal in File Explorer', testId: 'agent-detail-reveal', disabled: isNew, onSelect: () => revealInFileExplorer(path) },
    ...(!isNew ? [{ label: 'Delete agent…', testId: 'agent-detail-delete', danger: true, disabled: busy, onSelect: () => setConfirmDelete(true) }] : []),
  ]

  const actions = (
    <>
      <button
        type="button"
        onClick={onDuplicate}
        disabled={busy}
        className="h-9 px-4 rounded-[10px] bg-bg-hi border border-line text-[13.5px] font-medium text-fg hover:border-rule disabled:opacity-40"
      >
        Duplicate
      </button>
      <MoreMenu items={menuItems} />
    </>
  )

  return (
    <div data-testid="agent-detail" className="flex-1 min-h-0 flex flex-col">
      <ConfigDetailHeader
        eyebrow={`AGENT · USER · ${compactPath(path, home)}`}
        title={obj.name}
        pill={isNew ? 'unsaved draft' : dirty ? 'edited' : undefined}
        actions={actions}
      />
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

      <div className="flex-1 min-h-0 flex flex-col gap-4 px-9 py-6">
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

        <section data-testid="agent-runtime-card" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-4">
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <ModelPicker value={obj.model} onChange={(v) => set({ model: v })} />
            <EffortPicker value={obj.effort} model={obj.model} onChange={(v) => set({ effort: v })} />
            <Field
              label="runs on"
              hint="Which coding-agent CLI New Session starts this persona on — override per session in New Session → advanced. On a non-Claude CLI the session has no develop loop, no Restore, and this persona's model/effort are not used. Macros, phone launches and scheduled PRDs always run Claude Code."
            >
              <div className="space-y-2">
                <AgentCliPicker
                  testIdPrefix="agent-persona-cli"
                  value={obj.agentCli}
                  onChange={(id) => set({ agentCli: id, agentCliModel: '' })}
                />
                {obj.agentCli !== 'claude' && (
                  <input
                    data-testid="agent-persona-cli-model"
                    aria-label="CLI model"
                    value={obj.agentCliModel}
                    maxLength={128}
                    placeholder="Blank = the CLI's own default"
                    onChange={(e) => set({ agentCliModel: e.target.value })}
                    className="w-full bg-bg border border-line rounded px-2 py-1 text-xs text-fg font-mono"
                  />
                )}
              </div>
            </Field>
          </div>

          <div className="flex items-start gap-3" data-testid="agent-tools-row">
            <RowLabel>tools</RowLabel>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap gap-1.5">
                {TOOLS.map((t) => {
                  const on = obj.tools.includes(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      data-tool={t}
                      onClick={() => set({ tools: on ? obj.tools.filter((x) => x !== t) : [...obj.tools, t] })}
                      className={`px-2 py-0.5 rounded-md text-[12px] font-mono border ${
                        on ? 'bg-honey/20 text-honey-dark border-honey/40' : 'bg-transparent text-fg-faint border-dashed border-rule'
                      }`}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
              <div className="text-[11px] text-fg-faint mt-1 leading-snug">
                {obj.tools.length} of {TOOLS.length} granted. Anything not filled is refused at call time.
              </div>
            </div>
          </div>

          <div className="border-t border-line pt-3 flex flex-col gap-3">
            <div className="flex items-start gap-3" data-testid="agent-overrides-row">
              <RowLabel>project overrides</RowLabel>
              <div className="flex-1 min-w-0">
                {overrides.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
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
                    <span className="text-[12px] text-fg-faint">
                      {overrides.length === 1
                        ? `a local copy in ${compactPath(overrides[0].cwd, home)}/.claude/agents/ wins there`
                        : "each project's local copy in its .claude/agents/ wins there"}
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-fg-faint italic pt-1">
                    {isNew ? 'save first to see project overrides.' : 'no open project overlays this agent — the global definition applies everywhere.'}
                  </div>
                )}
              </div>
            </div>
            {!isNew && saved && (
              <ProjectOverrideBlock saved={saved} projects={projects} selected={selected} onSelect={onSelect} busy={busy} onSave={onSaveOverride} />
            )}
          </div>
        </section>

        <section data-testid="agent-identity-card" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col gap-3">
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
        </section>

        <div
          data-testid="agent-detail-editor"
          data-busy={busy ? 'true' : undefined}
          className="flex-1 min-h-[420px] rounded-[14px] border border-line bg-bg-hi overflow-hidden"
        >
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
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint mb-1.5">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-fg-faint mt-1 leading-snug">{hint}</div>}
    </div>
  )
}

const LATEST = 'latest'
const BLOCKED_REASON = 'Blocked by the availableModels allowlist in your Claude settings'

/**
 * Two-level, catalog-driven model picker: an alias row (every alias the installed
 * CLI offers, `inherit` prepended) and, for family aliases, a version row pinning a
 * concrete id. The stored value is written verbatim — a bare alias, or a concrete
 * id (with the alias's `[1m]` suffix when one is chosen). `catalog === null`
 * degrades to the static five chips.
 */
function ModelPicker({ value, onChange, label = 'model', hint, testIdPrefix = '', inheritLabel }: {
  value: string; onChange: (v: string) => void; label?: string; hint?: string; testIdPrefix?: string; inheritLabel?: string
}) {
  const { catalog, loading, degraded, refresh } = useModelCatalog(null)
  const aliases = catalog ? ['inherit', ...catalog.aliases] : [...MODELS]
  const allow = catalog?.availableModels ?? null
  const blockedAlias = (a: string) => !!allow && a !== 'inherit' && !allow.includes(a)
  const blockedId = (id: string, fam: string | null) => !!allow && !allow.includes(id) && !(fam && allow.includes(fam))

  const stored = value || 'inherit'
  const suffix = /\[[^\]]*\]$/.exec(stored)?.[0] ?? ''
  const isAlias = aliases.includes(stored)
  // A pinned concrete id maps back to its family alias (+ suffix) so the alias row shows it selected.
  const pinnedAlias = !isAlias && catalog && modelFamily(stored) && aliases.includes(modelFamily(stored)! + suffix)
    ? modelFamily(stored)! + suffix
    : null
  const aliasValue = isAlias ? stored : pinnedAlias ?? stored
  const family = modelFamily(aliasValue)
  const aliasSuffix = /\[[^\]]*\]$/.exec(aliasValue)?.[0] ?? ''
  const showVersion = !!catalog && stored !== 'inherit' && !!family && aliases.includes(aliasValue)
  const versions = showVersion ? catalog!.models.filter((id) => modelFamily(id) === family).map((id) => id + aliasSuffix) : []
  const versionValue = isAlias ? LATEST : stored

  const blocked: Record<string, string> = {}
  if (catalog) for (const a of aliases) if (blockedAlias(a)) blocked[a] = BLOCKED_REASON
  const blockedVersions: Record<string, string> = {}
  for (const v of versions) if (blockedId(v, family)) blockedVersions[v] = BLOCKED_REASON

  return (
    <Field
      label={label}
      hint={hint ?? "This persona's default model for its Epics — sets the --model an Epic launches with (Terminal + Chat both honor it). 'inherit' falls back to each view's own default, not this Settings page. Cheap models for read-only personas; opus for judgement calls."}
    >
      <div data-testid={`${testIdPrefix}model-row`}>
        <Choice options={aliases} value={aliasValue} onChange={onChange} mono blocked={blocked} labels={inheritLabel ? { inherit: inheritLabel } : undefined} />
      </div>
      {showVersion && (
        <div className="mt-2" data-testid={`${testIdPrefix}model-version-row`}>
          <div className="text-[10.5px] text-fg-faint mb-1 font-mono">version</div>
          <Choice
            options={[LATEST, ...versions]}
            value={versionValue}
            onChange={(v) => onChange(v === LATEST ? aliasValue : v)}
            mono
            blocked={blockedVersions}
          />
        </div>
      )}
      <div className="text-[11px] text-fg-faint mt-1 leading-snug flex items-center gap-2">
        <span>
          {catalog
            ? `Models are live-read from the installed claude CLI${degraded ? ' (cached — CLI probe unavailable)' : ''}. "latest" keeps the floating alias.`
            : loading ? 'Loading model catalog…' : 'catalog unavailable — showing the standard list.'}
        </span>
        <button
          data-testid={`${testIdPrefix}model-catalog-refresh`}
          onClick={() => { void refresh() }}
          disabled={loading}
          className="underline text-fg-dim disabled:opacity-40"
        >
          refresh
        </button>
      </div>
    </Field>
  )
}

/**
 * Catalog-driven effort picker. Options are `inherit` + the levels `/effort` accepts in a live
 * session (`catalog.effortLevels`); levels absent from `settingsEffortLevels` cannot be written to a
 * settings.json file and get a session-only marker. `catalog === null` degrades to the static list.
 * A model known not to support effort gets a non-blocking note — the control stays enabled.
 */
function EffortPicker({ value, model, onChange, label = 'effort', testIdPrefix = '', inheritLabel }: {
  value: string; model: string; onChange: (v: string) => void; label?: string; testIdPrefix?: string; inheritLabel?: string
}) {
  const { catalog } = useModelCatalog(null)
  const levels = catalog && catalog.effortLevels.length ? ['inherit', ...catalog.effortLevels] : [...EFFORTS]
  const settingsLevels = catalog?.settingsEffortLevels ?? []
  const sessionOnly = catalog ? levels.filter((l) => l !== 'inherit' && !settingsLevels.includes(l)) : []
  const stored = value || 'inherit'
  const unsupported = stored !== 'inherit' && modelSupportsEffort(model) === false
  return (
    <Field
      label={label}
      hint={
        catalog
          ? `Effort levels are live-read from the installed claude CLI (what /effort accepts). ${
              sessionOnly.length ? `${sessionOnly.join(', ')} ${sessionOnly.length > 1 ? 'are' : 'is'} session-only — settings.json accepts ${settingsLevels.join(', ')}. ` : ''
            }'inherit' writes no effort: line.`
          : "catalog unavailable — showing the standard list. 'inherit' writes no effort: line."
      }
    >
      <div data-testid={`${testIdPrefix}effort-row`}>
        <Choice options={levels} value={stored} onChange={onChange} mono labels={inheritLabel ? { inherit: inheritLabel } : undefined} />
      </div>
      {sessionOnly.length > 0 && (
        <div className="text-[11px] text-fg-faint mt-1 font-mono" data-testid={`${testIdPrefix}effort-session-only`}>
          {sessionOnly.map((l) => `${l} (session-only)`).join(' · ')}
        </div>
      )}
      {unsupported && (
        <div className="text-[11px] text-amber-400 mt-1 leading-snug" data-testid={`${testIdPrefix}effort-unsupported-note`}>
          The selected model does not support effort — the CLI will ignore this setting.
        </div>
      )}
    </Field>
  )
}

/**
 * PROJECT OVERRIDE — an explicit project picker over every open project (one option per unique tab cwd,
 * nothing preselected: the page never reads the active tab, so no open project is special), then the CHOSEN
 * project's runtime model/effort for this persona, written as a frontmatter-only overlay at
 * `<cwd>/.claude/agents/<name>.md` (no body; lib/persona-macro/personaMerge.cjs inherits the rest from the
 * global persona). An option whose project already overrides this persona names what it overrides; two open
 * projects sharing a folder name are labelled by their home-shortened paths instead. Deliberately a separate
 * block from the global rows above it: those edit `~/.claude/agents/<name>.md` for the whole machine, these
 * edit only the chosen project's file. Each picker writes on change (no draft/Save step) so the two scopes
 * never share a Save button. The choice is AgentLibrary's page state (it survives switching personas) and
 * falls back to "Choose a project…" once that project's tab closes.
 */
function ProjectOverrideBlock({ saved, projects, selected, onSelect, busy, onSave }: {
  saved: AgentPersona
  projects: OpenProject[]
  selected: OpenProject | null
  onSelect: (cwd: string | null) => void
  busy: boolean
  onSave: (patch: { model: string; effort: string }) => void
}) {
  const home = useHomeDir()
  const nameCount = new Map<string, number>()
  for (const p of projects) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1)
  const optionLabel = (p: OpenProject) => {
    const label = (nameCount.get(p.name) ?? 0) > 1 ? compactPath(p.cwd, home) : p.name
    const d = saved.overrideDetails?.find((x) => x.cwd === p.cwd)
    if (!d) return label
    const parts = overrideParts(d)
    return `${label} — ${parts.length ? `overrides ${parts.join(', ')}` : 'overlay'}`
  }
  // By cwd, not folder name: two open projects sharing a name must not read each other's overlay.
  const detail = selected ? saved.overrideDetails?.find((d) => d.cwd === selected.cwd) : undefined
  const fullBody = !!detail?.bodyOverridden
  const model = detail?.values?.model ?? 'inherit'
  const effort = detail?.values?.effort ?? 'inherit'
  const globalModel = saved.model ?? 'inherit'
  const globalEffort = saved.effort ?? 'inherit'

  return (
    <div
      data-testid="project-override-block"
      className={selected ? 'border border-accent/40 rounded p-3 space-y-3 bg-accent/5' : 'border border-dashed border-line rounded p-3 space-y-3'}
    >
      <label className="flex flex-col gap-1">
        <span className={`text-[10.5px] font-semibold uppercase tracking-wide font-mono ${selected ? 'text-accent' : 'text-fg-faint'}`}>
          project override
        </span>
        <select
          data-testid="override-project-select"
          value={selected?.cwd ?? ''}
          onChange={(e) => onSelect(e.target.value || null)}
          disabled={busy || projects.length === 0}
          className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12.5px] text-fg disabled:opacity-60"
        >
          <option value="">Choose a project…</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>{optionLabel(p)}</option>
          ))}
        </select>
      </label>
      {projects.length === 0 ? (
        <div data-testid="project-override-none" className="text-[11px] text-fg-faint leading-snug">
          No open project tabs — open a project tab to override this persona&apos;s model or effort for it.
        </div>
      ) : !selected ? (
        <div data-testid="project-override-unselected" className="text-[11px] text-fg-faint leading-snug">
          Pick an open project to see or set this persona&apos;s model and effort for that project only. A project that
          already overrides this persona says what it overrides.
        </div>
      ) : (
        <div data-testid="project-override" className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="accent">{selected.name} only</Badge>
            <span className="ml-auto min-w-0"><SourceChip path={`${selected.cwd}/.claude/agents/${saved.name}.md`} /></span>
          </div>
          <div className="text-[11px] text-fg-faint leading-snug">
            Changes what the SCHEDULER (and new Epics) spawn for <strong>{selected.name}</strong> only — a frontmatter-only overlay with just the keys you set;
            the persona&apos;s body stays the global one. The global model/effort rows edit the machine-wide persona and are never touched here.
          </div>
          {fullBody && (
            <div data-testid="project-override-fullbody" className="text-[11px] text-amber-400 leading-snug">
              {selected.name} already has a FULL-BODY override of this persona (its own definition text). It is shown as-is and not converted to a
              frontmatter-only overlay — edit that file directly, or drop it with × under &quot;project overrides&quot; below.
            </div>
          )}
          <fieldset disabled={busy || fullBody} className="space-y-3 border-0 p-0 m-0 min-w-0">
            <ModelPicker
              value={model}
              onChange={(v) => { if (!fullBody) onSave({ model: v, effort }) }}
              label="project model"
              hint="'use global' writes no model: line in the overlay."
              testIdPrefix="override-"
              inheritLabel="use global"
            />
            <EffortPicker
              value={effort}
              model={model !== 'inherit' ? model : globalModel}
              onChange={(v) => { if (!fullBody) onSave({ model, effort: v }) }}
              label="project effort"
              testIdPrefix="override-"
              inheritLabel="use global"
            />
          </fieldset>
          <div data-testid="override-provenance" className="text-[11px] font-mono text-fg-dim space-y-0.5">
            {[['model', globalModel, model], ['effort', globalEffort, effort]].map(([k, g, o]) => (
              <div key={k} data-testid={`override-provenance-${k}`}>
                {k}: {o !== 'inherit' ? <>{g} <span className="text-fg-faint">(global)</span> → <span className="text-accent">{o}</span> <span className="text-fg-faint">(this project)</span></> : <>{g} <span className="text-fg-faint">(global — not overridden)</span></>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
