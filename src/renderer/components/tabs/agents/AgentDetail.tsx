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
  /** Gear: declared MCP servers / context packs. Absent until the gear panel edits them (servers otherwise derive from the mcp__ tools). */
  mcpServers?: string[]
  packs?: string[]
  /** Declared sandbox environment profile (`environment:` frontmatter); absent = headless-default. */
  environment?: string
  /** The loadout decision made in this draft (first-run choice). Absent = no decision made here; `tools` alone carries Equipped/Unbound. */
  loadout?: 'bare' | 'equipped' | 'unbound'
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
    ...gearOf(p),
  }
}

function gearOf(p: AgentPersona): Pick<Draft, 'mcpServers' | 'packs' | 'environment'> {
  const g = p as AgentPersona & Pick<Draft, 'mcpServers' | 'packs' | 'environment'>
  return { ...(g.mcpServers ? { mcpServers: g.mcpServers } : {}), ...(g.packs ? { packs: g.packs } : {}), ...(g.environment ? { environment: g.environment } : {}) }
}

export const BLANK_DRAFT: Draft = { name: 'new-agent', description: '', tools: ['Read', 'Grep'], model: 'inherit', effort: 'inherit', color: '', tags: [], body: '', agentCli: 'claude', agentCliModel: '' }

type OverrideDetail = NonNullable<AgentPersona['overrideDetails']>[number]

/** An open project the PROJECT OVERRIDE picker can target: a unique normalized tab cwd and its folder name. */
export interface OpenProject { cwd: string; name: string }

/** What one project's overlay of a persona overrides: its frontmatter keys (minus `name`), plus "full body". */
export function overrideParts(d: OverrideDetail): string[] {
  return [...d.fields.filter((f) => f !== 'name'), ...(d.bodyOverridden ? ['full body'] : [])]
}

/** The keys a project overlay can carry (absent = inherits the global persona). `tools: []` = every tool. */
export interface OverlayKeys {
  model?: string
  effort?: string
  tools?: string[]
  mcpServers?: string[]
  packs?: string[]
  environment?: string
}
const OVERLAY_ARRAY_KEYS = ['tools', 'mcpServers', 'packs'] as const
const splitList = (v: string): string[] => v.split(',').map((x) => x.trim()).filter((x) => x && x !== '[]')

/** A project's overlay as typed keys, parsed from the merged view's per-key values. */
export function overlayOf(d: OverrideDetail): OverlayKeys {
  const v = d.values ?? {}
  const out: OverlayKeys = {}
  if (d.fields.includes('model') && v.model) out.model = v.model
  if (d.fields.includes('effort') && v.effort) out.effort = v.effort
  if (d.fields.includes('environment') && v.environment) out.environment = v.environment
  if (d.fields.includes('tools') && v.tools !== undefined) { const t = splitList(String(v.tools)); out.tools = t }
  if (d.fields.includes('mcpServers') && v.mcpServers !== undefined) out.mcpServers = splitList(String(v.mcpServers))
  if (d.fields.includes('packs') && v.packs !== undefined) out.packs = splitList(String(v.packs))
  return out
}

/** Apply a draft-shaped edit to an overlay: 'inherit' / empty list / blank = the key goes back to global (an explicitly emptied tools/mcpServers/packs is kept as [] = replace with none). */
export function overlayEdit(overlay: OverlayKeys, patch: Partial<Draft>): OverlayKeys {
  const next: OverlayKeys = { ...overlay }
  for (const k of ['model', 'effort', 'environment'] as const) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (!v || v === 'inherit') delete next[k]
    else next[k] = v
  }
  if (patch.tools) next.tools = patch.tools
  for (const k of ['mcpServers', 'packs'] as const) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v) next[k] = v
    else delete next[k]
  }
  return next
}

/** Per overridden key: what differs from the global draft, as display lines. */
export function overlayDiff(global: Draft, overlay: OverlayKeys): Array<{ label: string; keys: Array<keyof OverlayKeys>; lines: string[] }> {
  const out: Array<{ label: string; keys: Array<keyof OverlayKeys>; lines: string[] }> = []
  for (const k of ['model', 'effort', 'environment'] as const) {
    const o = overlay[k]
    if (o !== undefined) out.push({ label: k, keys: [k], lines: [`~ ${global[k] ?? 'default'} → ${o}`] })
  }
  for (const k of OVERLAY_ARRAY_KEYS) {
    const o = overlay[k]
    if (o === undefined) continue
    const g = global[k] ?? []
    const lines = [...o.filter((x) => !g.includes(x)).map((x) => `+ ${x}`), ...g.filter((x) => !o.includes(x)).map((x) => `− ${x}`)]
    out.push({ label: k, keys: [k], lines: lines.length ? lines : ['same as global'] })
  }
  return out
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
