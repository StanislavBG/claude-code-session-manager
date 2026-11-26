import { useEffect, useId, useRef, useState } from 'react'
import { Badge } from '../../ui/Badge'
import { SourceChip } from '../../ui/SourceChip'
import { Choice } from '../../ui/Choice'
import { useHomeDir } from '../../../lib/useHomeDir'
import { useModelCatalog } from '../../../lib/useModelCatalog'
import { modelFamily } from '../../../lib/prettyModel'
import { modelSupportsEffort } from '../../../lib/effortSupport'
import { MODELS, EFFORTS } from '../../../lib/agentRuntimeOptions'
import { compactPath } from '../../../lib/compactPath'
import { Z } from '../../../lib/zLayers'
import type { AgentCliChoice } from '../../epics/AgentCliPicker'
import { useAgentCliDetect } from '../../../lib/useAgentCliDetect'
import { AGENT_CLI_LABELS, type AgentCliId } from '../../../lib/agentCliCatalog'
import type { AgentPersona } from '../../../../preload/api'

/**
 * Agent persona data + shared form controls. The sheet layout lives in ./AgentSheet.tsx; this module
 * keeps the draft model (Draft / toDraft / BLANK_DRAFT), the override helpers, the catalog-driven
 * model / effort / runs-on selects and the project-override block the sheet composes.
 */

export const TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']
export const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
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
export function overrideChipText(d: OverrideDetail): string {
  const vals = [d.values?.model, d.values?.effort].filter((v): v is string => !!v)
  if (d.bodyOverridden) vals.push('full body')
  if (vals.length) return vals.join(' · ')
  return overrideParts(d).join(', ') || 'overlay'
}

export function MoreMenu({ items }: { items: ReadonlyArray<{ label: string; testId: string; danger?: boolean; disabled?: boolean; info?: boolean; onSelect: () => void }> }) {
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
          {items.map((item) => item.info ? (
            <div
              key={item.testId}
              role="note"
              data-testid={item.testId}
              className="px-2.5 pb-[7px] pt-0.5 text-[11px] text-fg-faint whitespace-nowrap border-b border-line mb-1"
            >
              {item.label}
            </div>
          ) : (
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
export function RowLabel({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 w-[150px] text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint pt-1">{children}</span>
}

/** Settings-row select look (EffectiveCards): native chevron hidden, our own chevron drawn over it. */
const SELECT_CLASS =
  'w-full h-9 appearance-none pl-3 pr-8 rounded border border-line bg-bg-hi font-mono text-[13px] text-fg focus:outline-none focus:border-fg-faint disabled:opacity-60'

/** One compact labelled select of the runtime row; the long help text rides on the select's title. */
function CompactSelect({ label, hint, testId, value, onChange, children }: {
  label: string; hint: string; testId: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <label className="min-w-0 flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">{label}</span>
      <span className="relative block">
        <select data-testid={testId} aria-label={label} title={hint} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
          {children}
        </select>
        <svg
          aria-hidden
          data-testid={`${testId}-chevron`}
          viewBox="0 0 16 16"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </label>
  )
}

const suffixOf = (v: string) => /\[[^\]]*\]$/.exec(v)?.[0] ?? ''

/**
 * Compact catalog-driven model select: `inherit` + every alias the installed CLI offers, then every
 * concrete id (and each family's `[…]`-suffixed variant, for suffixed aliases) as pinned versions.
 * The stored value is written verbatim; a value in neither list is kept as a selected "(current)"
 * option so an untouched save never rewrites it. Allowlist-blocked options are disabled, not hidden.
 */
export function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { catalog } = useModelCatalog(null)
  const aliases = catalog ? ['inherit', ...catalog.aliases] : [...MODELS]
  const allow = catalog?.availableModels ?? null
  const pinned: string[] = []
  if (catalog) {
    const seen = new Set<string>()
    const add = (id: string) => { if (!seen.has(id) && !aliases.includes(id)) { seen.add(id); pinned.push(id) } }
    for (const id of catalog.models) add(id)
    for (const a of catalog.aliases) {
      const fam = modelFamily(a)
      const sfx = suffixOf(a)
      if (fam && sfx) for (const id of catalog.models) if (modelFamily(id) === fam) add(id + sfx)
    }
  }
  const blockedAlias = (a: string) => !!allow && a !== 'inherit' && !allow.includes(a)
  const blockedId = (id: string) => {
    const fam = modelFamily(id)
    return !!allow && !allow.includes(id) && !(fam && allow.includes(fam + suffixOf(id))) && !(fam && allow.includes(fam))
  }
  const stored = value || 'inherit'
  const known = aliases.includes(stored) || pinned.includes(stored)
  const hint = "This persona's default model for its Epics — sets the --model an Epic launches with (Terminal + Chat both honor it). 'inherit' falls back to each view's own default, not this Settings page. Cheap models for read-only personas; opus for judgement calls. Pinned versions fix a concrete id; an alias floats to the latest."
  return (
    <CompactSelect label="model" hint={hint} testId="model-select" value={stored} onChange={onChange}>
      {!known && <option value={stored}>{stored} (current)</option>}
      <optgroup label="Aliases">
        {aliases.map((a) => (
          <option key={a} value={a} disabled={!!catalog && blockedAlias(a)} title={blockedAlias(a) ? BLOCKED_REASON : undefined}>{a}</option>
        ))}
      </optgroup>
      {pinned.length > 0 && (
        <optgroup label="Pinned versions">
          {pinned.map((id) => (
            <option key={id} value={id} disabled={blockedId(id)} title={blockedId(id) ? BLOCKED_REASON : undefined}>{id}</option>
          ))}
        </optgroup>
      )}
    </CompactSelect>
  )
}

/**
 * Compact effort select: `inherit` + the levels `/effort` accepts (catalog), session-only levels
 * (absent from `settingsEffortLevels`) marked in their label. An unlisted stored value stays as a
 * selected "(current)" option. A model known not to support effort gets a short non-blocking note.
 */
export function EffortSelect({ value, model, onChange }: { value: string; model: string; onChange: (v: string) => void }) {
  const { catalog } = useModelCatalog(null)
  const levels = catalog && catalog.effortLevels.length ? ['inherit', ...catalog.effortLevels] : [...EFFORTS]
  const settingsLevels = catalog?.settingsEffortLevels ?? []
  const sessionOnly = catalog ? levels.filter((l) => l !== 'inherit' && !settingsLevels.includes(l)) : []
  const stored = value || 'inherit'
  const unsupported = stored !== 'inherit' && modelSupportsEffort(model) === false
  const hint = catalog
    ? `Effort levels are live-read from the installed claude CLI (what /effort accepts). ${
        sessionOnly.length ? `${sessionOnly.join(', ')} ${sessionOnly.length > 1 ? 'are' : 'is'} session-only — settings.json accepts ${settingsLevels.join(', ')}. ` : ''
      }'inherit' writes no effort: line.`
    : "Catalog unavailable — showing the standard list. 'inherit' writes no effort: line."
  return (
    <div className="min-w-0 flex flex-col gap-1">
      <CompactSelect label="effort" hint={hint} testId="effort-select" value={stored} onChange={onChange}>
        {!levels.includes(stored) && <option value={stored}>{stored} (current)</option>}
        {levels.map((l) => (
          <option key={l} value={l}>{sessionOnly.includes(l) ? `${l} (session-only)` : l}</option>
        ))}
      </CompactSelect>
      {unsupported && (
        <div className="text-[11px] text-amber-400 leading-snug" data-testid="effort-unsupported-note">
          This model ignores effort.
        </div>
      )}
    </div>
  )
}

const CLI_ORDER: AgentCliId[] = ['codex', 'gemini', 'antigravity', 'cursor', 'opencode']

/**
 * Compact RUNS ON select over the same shared detection as New Session's AgentCliPicker
 * (`useAgentCliDetect`): Claude Code always enabled; a not-installed CLI is a disabled option
 * whose label says so (its install command rides on the title). Re-check lives in the ⋯ menu.
 */
export function RunsOnSelect({ value, onChange }: { value: AgentCliChoice; onChange: (id: AgentCliChoice) => void }) {
  const { rows } = useAgentCliDetect()
  const byId = new Map((rows ?? []).map((r) => [r.id, r]))
  const hint = 'Which coding-agent CLI New Session starts this persona on — override per session in New Session → advanced. On a non-Claude CLI the session has no develop loop, no Restore, and this persona\'s model/effort are not used. Macros, phone launches and scheduled PRDs always run Claude Code.'
  return (
    <CompactSelect label="runs on" hint={hint} testId="agent-persona-cli-select" value={value} onChange={(v) => onChange(v as AgentCliChoice)}>
      <option value="claude">Claude Code</option>
      {CLI_ORDER.map((id) => {
        const row = byId.get(id)
        const label = row?.label || AGENT_CLI_LABELS[id]
        const installed = Boolean(row?.installed)
        const state = row ? (installed ? '' : ' (not installed)') : rows === null ? ' (checking…)' : ' (not detected)'
        const title = row ? (installed ? [row.version, row.path].filter(Boolean).join(' · ') || undefined : row.install ?? 'Not installed') : undefined
        return (
          <option key={id} value={id} disabled={!installed && value !== id} title={title}>{label}{state}</option>
        )
      })}
    </CompactSelect>
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
export function ProjectOverrideBlock({ saved, projects, selected, onSelect, busy, onSave, onClose }: {
  saved: AgentPersona
  onClose: () => void
  projects: OpenProject[]
  selected: OpenProject | null
  onSelect: (cwd: string | null) => void
  busy: boolean
  onSave: (patch: { model: string; effort: string }) => void
}) {
  const home = useHomeDir()
  const selectId = useId()
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
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className={`flex-1 text-[10.5px] font-semibold uppercase tracking-wide font-mono ${selected ? 'text-accent' : 'text-fg-faint'}`}>
          project override
        </label>
        <button type="button" data-testid="override-close" onClick={onClose} className="text-[11px] text-fg-faint hover:text-fg">
          Done
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <select
          id={selectId}
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
      </div>
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
              frontmatter-only overlay — edit that file directly, or drop it with its × in the &quot;project overrides&quot; row above.
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
