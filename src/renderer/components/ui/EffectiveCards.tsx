import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Scope } from '../../lib/scopes'
import { SCOPE_LABELS } from '../../lib/scopes'
import type { EffectiveNode, LeafNode } from '../../lib/mergeScopes'
import type { SchemaResolver, SchemaInfo } from '../../lib/schemaLookup'
import { planGroups, planGroupRail, humanizeKey, type GroupRailEntry } from '../../lib/settingsGroups'
import { resolveSettingDescription } from '../../lib/settingsDescriptionFallbacks'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'
import { Toggle } from './Toggle'
import { Z } from '../../lib/zLayers'

/** Judgment-call icon per settings group id; 'other' is planGroups' dynamic fallback bucket. */
const GROUP_ICONS: Record<string, AlmanacIconName> = {
  essentials: 'star',
  git: 'link',
  memory: 'memory',
  model: 'sparkle',
  interface: 'eye',
  updates: 'reload',
  env: 'keys',
  hooks: 'hooks',
  mcp: 'mcp',
  plugins: 'plugins',
  filesystem: 'folder',
  login: 'lock',
  feedback: 'send',
  advanced: 'shield',
  other: 'dot',
}

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint'

type OnOverride = (path: string[], value: unknown, intoScope?: Scope) => void

/**
 * Grandma-friendly view of merged settings, on the Claude config workbench design.
 *
 * Groups keys into themed sections (see settingsGroups.ts). `SettingsGroupRail` is the
 * left-column group list (icon, title, set/total); `SettingsGroupCards` renders the chosen
 * group(s) as setting cards — name, mono key, description, ONE control by type that writes the
 * selected scope's file, a `SourceLadder` marking where the effective value comes from
 * (Default — User on Home, Default — User — Project — Local in a project), and a ⋯ menu
 * holding Reset and the values-across-scopes table. Shared filter / showAdvanced / showUnset
 * state lives in ONE place — `useEffectiveCards`.
 */

export interface EffectiveCardsModel {
  filter: string
  setFilter: (v: string) => void
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  showUnset: boolean
  setShowUnset: (v: boolean) => void
  rootNode: Extract<EffectiveNode, { kind: 'object' }> | null
  schema: SchemaResolver
  groups: ReturnType<typeof planGroups>
  railGroups: GroupRailEntry[]
  visibleGroups: ReturnType<typeof planGroups>
  /** Every editable key across all groups (the 'Search N settings' count). */
  totalKeys: number
}

export function useEffectiveCards({ node, schema }: { node: EffectiveNode; schema: SchemaResolver }): EffectiveCardsModel {
  const [filter, setFilter] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showUnset, setShowUnset] = useState(true)

  const rootNode = node.kind === 'object' ? node : null
  const presentKeys = rootNode ? Object.keys(rootNode.children) : []
  const knownKeys = schema.rootKeys()
  const allKeys = new Set<string>([...presentKeys, ...knownKeys])
  const allKeysSig = Array.from(allKeys).sort().join(',')
  const presentSig = presentKeys.join(',')

  const groups = useMemo(() => planGroups(allKeys), [allKeysSig])

  const railGroups = useMemo(
    () => planGroupRail(allKeys, new Set(presentKeys)),
    [allKeysSig, presentSig],
  )

  const totalKeys = useMemo(() => groups.reduce((n, g) => n + g.keys.length, 0), [groups])

  const visibleGroups = useMemo(() => {
    return groups
      .filter((g) => showAdvanced || !g.advanced)
      .map((g) => ({
        ...g,
        keys: g.keys.filter((k) => {
          const isSet = rootNode?.children[k] !== undefined
          if (!showUnset && !isSet) return false
          if (!filter.trim()) return true
          const info = schema.at([k])
          const hay = [k, humanizeKey(k), info?.description ?? ''].join(' ').toLowerCase()
          return hay.includes(filter.toLowerCase())
        }),
      }))
      .filter((g) => g.keys.length > 0)
  }, [groups, filter, showAdvanced, showUnset, rootNode, schema])

  return {
    filter, setFilter, showAdvanced, setShowAdvanced, showUnset, setShowUnset,
    rootNode, schema, groups, railGroups, visibleGroups, totalKeys,
  }
}

/* ------------------------------------------------------------- GroupRail */

/** Left-column group list: icon, title, set/total. `selectedId` null = nothing highlighted. */
export function SettingsGroupRail({
  cards,
  selectedId,
  onSelect,
}: {
  cards: EffectiveCardsModel
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-px" role="listbox" aria-label="Settings groups">
      {cards.railGroups.map((g) => {
        const selected = g.id === selectedId
        return (
          <button
            key={g.id}
            type="button"
            role="option"
            aria-selected={selected}
            data-testid="settings-group-row"
            data-group-id={g.id}
            onClick={() => onSelect(g.id)}
            className={`w-full flex items-center gap-2.5 h-[34px] px-3 rounded-[9px] border text-left text-[13.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
              selected ? 'bg-bg-hi border-line font-semibold text-fg' : 'border-transparent text-fg-dim hover:bg-bg-hi/60'
            }`}
          >
            <AlmanacIcon
              name={GROUP_ICONS[g.id] ?? 'dot'}
              size={16}
              className={`shrink-0 ${selected ? 'text-accent' : 'text-fg-faint'}`}
            />
            <span className="flex-1 min-w-0 truncate">{g.title}</span>
            <span className={`shrink-0 font-mono text-xs ${g.setCount ? 'text-fg-dim' : 'text-fg-faint'}`}>
              {g.setCount}/{g.total}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------ GroupCards */

/**
 * The detail body: one section per group in `groupIds` (in visibleGroups order), each a
 * caption line ('ESSENTIALS · THE KNOBS YOU REACH FOR FIRST') over its setting cards.
 */
export function SettingsGroupCards({
  cards,
  groupIds,
  targetScope,
  onOverride,
}: {
  cards: EffectiveCardsModel
  groupIds: ReadonlyArray<string>
  targetScope: Scope
  onOverride: OnOverride
}) {
  const { visibleGroups, rootNode, schema, filter } = cards
  const shown = visibleGroups.filter((g) => groupIds.includes(g.id))
  return (
    <div className="px-9 py-6 flex flex-col gap-[26px]">
      {shown.map((g) => (
        <section key={g.id} id={`settings-group-${g.id}`} data-testid="settings-group-section">
          <div className="flex items-baseline gap-3 mb-3">
            <span className={EYEBROW}>
              {g.title} · {g.summary.replace(/\.$/, '')}
            </span>
            {g.advanced && (
              <span className="text-[9px] px-1.5 rounded border border-line text-fg-faint uppercase tracking-wide">advanced</span>
            )}
            <span aria-hidden className="flex-1 h-px bg-line" />
          </div>
          <div className="flex flex-col gap-2.5">
            {g.keys.map((k) => (
              <SettingCard
                key={k}
                keyName={k}
                node={rootNode?.children[k]}
                info={schema.at([k])}
                targetScope={targetScope}
                onOverride={(v, intoScope) => onOverride([k], v, intoScope)}
              />
            ))}
          </div>
        </section>
      ))}
      {shown.length === 0 && (
        <div className="px-6 py-12 text-center text-fg-faint text-sm">
          {filter.trim() ? `no settings match "${filter}"` : 'nothing to show — turn on Show unset to see every setting in this group'}
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------- SourceLadder */

type Stage = Scope | 'default'
const LADDER: ReadonlyArray<{ stage: Stage; label: string }> = [
  { stage: 'default', label: 'Default' },
  { stage: 'user', label: 'User' },
  { stage: 'project', label: 'Project' },
  { stage: 'local', label: 'Local' },
]
/** The stages a face can hold: Home edits only the user file; a project adds Project + Local. */
export const HOME_STAGES: ReadonlyArray<Stage> = ['default', 'user']
export const PROJECT_STAGES: ReadonlyArray<Stage> = ['default', 'user', 'project', 'local']
/** Home (the user file) shows Default — User; a project file shows all four stages. */
export function ladderStagesFor(targetScope: Scope): ReadonlyArray<Stage> {
  return targetScope === 'user' ? HOME_STAGES : PROJECT_STAGES
}
/** Precedence, lowest first — mergeScopes' order (local beats project beats user). */
const PRECEDENCE: ReadonlyArray<Scope> = ['user', 'project', 'local']

/** Scopes that hold a value somewhere under `node` (leaf winner + shadowed, array items, object descendants). */
function scopesIn(node: EffectiveNode, into: Set<Scope>): void {
  if (node.kind === 'leaf') {
    into.add(node.winner)
    for (const s of node.shadowed) into.add(s.scope)
  } else if (node.kind === 'array') {
    for (const it of node.items) into.add(it.fromScope)
  } else {
    for (const child of Object.values(node.children)) scopesIn(child, into)
  }
}

/**
 * Where a setting's value comes from, read off the merged node mergeScopes already built
 * (no second reader): `has` = every stage holding a value, `effective` = the one that wins.
 * A leaf's winner is exact; for arrays / objects the most specific contributing scope wins.
 * Unset with a schema default → Default.
 */
export function settingSources(
  node: EffectiveNode | undefined,
  defaultVal: unknown,
): { effective: Stage | null; has: Set<Stage> } {
  const has = new Set<Stage>()
  if (defaultVal !== undefined) has.add('default')
  if (!node) return { effective: defaultVal !== undefined ? 'default' : null, has }
  const scopes = new Set<Scope>()
  scopesIn(node, scopes)
  scopes.forEach((s) => has.add(s))
  if (node.kind === 'leaf') return { effective: node.winner, has }
  const top = [...PRECEDENCE].reverse().find((s) => scopes.has(s)) ?? null
  return { effective: top, has }
}

export function SourceLadder({
  node,
  defaultVal,
  stages = PROJECT_STAGES,
}: {
  node: EffectiveNode | undefined
  defaultVal: unknown
  stages?: ReadonlyArray<Stage>
}) {
  const { effective, has } = settingSources(node, defaultVal)
  const shown = LADDER.filter((l) => stages.includes(l.stage))
  return (
    <div data-testid="source-ladder" className="flex items-center gap-1.5 whitespace-nowrap" aria-label="Where this value comes from">
      {shown.map(({ stage, label }, i) => {
        const win = stage === effective
        const present = has.has(stage)
        return (
          <span key={stage} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="w-3 h-px bg-line" />}
            <span
              data-stage={stage}
              data-effective={win ? 'true' : 'false'}
              title={win ? `effective value comes from ${label}` : present ? `${label} also sets this` : `not set in ${label}`}
              className={`flex items-center gap-1.5 text-xs ${
                win ? 'font-bold text-fg' : present ? 'font-medium text-fg-dim' : 'font-medium text-fg-faint/70'
              }`}
            >
              <span
                aria-hidden
                className={`w-2.5 h-2.5 rounded-full box-border border-[1.5px] ${
                  win
                    ? stage === 'default' ? 'bg-fg-faint border-fg-faint' : 'bg-accent border-accent'
                    : present ? 'border-fg-faint' : 'border-line'
                }`}
              />
              {label}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- Card */

interface CardProps {
  keyName: string
  node: EffectiveNode | undefined
  info: SchemaInfo | null
  targetScope: Scope
  onOverride: (value: unknown, intoScope?: Scope) => void
}

/**
 * One setting row (render 07 / 11): name + mono key + one-line description, ONE control by
 * type that writes the selected scope's file, the source ladder, and a ⋯ menu holding Reset
 * and the values-across-scopes table.
 */
function SettingCard({ keyName, node, info, targetScope, onOverride }: CardProps) {
  const [expanded, setExpanded] = useState(false)
  const title = humanizeKey(keyName)
  const isSet = node !== undefined
  const leafNode = node?.kind === 'leaf' ? node : null
  const defaultVal = info?.default
  const isDefault = !!leafNode && defaultVal !== undefined && sameValue(leafNode.value, defaultVal)

  // Reset = "delete from the most-specific scope that has it" (the leaf's winner). Offered
  // only when the effective value differs from the schema default.
  const canReset = !!leafNode && !isDefault
  const description = resolveSettingDescription(keyName, info?.description)
  // Re-key the control on the effective value / target file so its local draft follows the data.
  const editorKey = `${targetScope}:${leafNode ? JSON.stringify(leafNode.value) : '∅'}`

  return (
    <div
      data-testid="setting-card"
      data-key={keyName}
      className="px-[22px] py-4 rounded-[14px] bg-bg-hi border border-line"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,250px)_auto_auto] items-center gap-x-7 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <h3 className="text-base font-semibold text-fg">{title}</h3>
            <span className="font-mono text-xs text-fg-faint">{keyName}</span>
            {info?.deprecated && <span className="text-[11px] italic text-fg-faint">deprecated</span>}
            {info?.required && !isSet && <span className="text-[11px] italic text-fg-faint">required</span>}
          </div>
          {description && (
            <p
              className={`text-[13.5px] text-fg-dim mt-0.5 leading-relaxed ${
                description.authored ? 'inline-block border-b border-dotted border-fg-faint/70 cursor-help' : ''
              }`}
              title={description.authored ? 'In-app-authored description — not from the official Claude Code schema' : undefined}
            >
              {firstSentence(description.text)}
            </p>
          )}
        </div>
        <div className="min-w-0 text-[13px]">
          <Editor
            key={editorKey}
            keyName={keyName}
            node={node}
            info={info}
            onChange={(v) => onOverride(v)}
            targetLabel={SCOPE_LABELS[targetScope].label}
          />
        </div>
        <SourceLadder node={node} defaultVal={defaultVal} stages={ladderStagesFor(targetScope)} />
        <RowMenu
          keyName={keyName}
          title={title}
          expanded={expanded}
          onToggleDetails={() => setExpanded((v) => !v)}
          reset={
            canReset && leafNode
              ? { label: `Reset · remove from ${SCOPE_LABELS[leafNode.winner].label}`, run: () => onOverride(undefined, leafNode.winner) }
              : null
          }
        />
      </div>
      {expanded && (
        <div data-testid="setting-details" className="mt-3 pt-3 border-t border-line/60">
          {leafNode && <DriftTable leaf={leafNode} defaultVal={defaultVal} onReset={(s) => onOverride(undefined, s)} />}
          <CardDetails keyName={keyName} node={node} info={info} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ Row menu */

/** The per-row ⋯ menu: Reset (when the value differs from the default) and the details/drift table. */
function RowMenu({
  keyName,
  title,
  expanded,
  onToggleDetails,
  reset,
}: {
  keyName: string
  title: string
  expanded: boolean
  onToggleDetails: () => void
  reset: { label: string; run: () => void } | null
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Escape or a mousedown outside the trigger + menu closes it (same rule as PluginMenu).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev'
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="setting-row-menu"
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        ⋯
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${keyName}`}
          className={`absolute ${Z.dialog} right-0 top-9 min-w-[220px] p-[5px] flex flex-col gap-1 bg-bg-hi border border-line rounded-lg shadow-lg text-[13px] text-fg`}
        >
          {reset && (
            <button
              type="button"
              role="menuitem"
              data-testid="setting-row-reset"
              className={item}
              onClick={() => {
                setOpen(false)
                reset.run()
              }}
            >
              ↺ {reset.label}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="setting-row-details"
            className={item}
            onClick={() => {
              setOpen(false)
              onToggleDetails()
            }}
          >
            {expanded ? 'Hide values across scopes' : 'Values across scopes…'}
          </button>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------- DriftTable */

function DriftTable({
  leaf,
  defaultVal,
  onReset,
}: {
  leaf: LeafNode
  defaultVal: unknown
  onReset: (scope: Scope) => void
}) {
  // Build a complete 4-row view (one per file scope + schema default). Even
  // unset scopes are rendered with a "—" so the user can see exactly why a
  // value drifts from each particular place.
  const valuesByScope: Partial<Record<Scope, { value: unknown; winner: boolean }>> = {}
  valuesByScope[leaf.winner] = { value: leaf.value, winner: true }
  for (const s of leaf.shadowed) {
    valuesByScope[s.scope] = { value: s.value, winner: false }
  }
  return (
    <div className="mt-2 border border-line rounded bg-bg-elev/40 text-xs">
      <div className="px-2 py-1 text-fg-faint border-b border-line/60">
        Values across all scopes (winner highlighted · reset removes that scope's value):
      </div>
      <div className="divide-y divide-line/60">
        {(['user', 'project', 'local'] as Scope[]).map((s) => {
          const entry = valuesByScope[s]
          const present = entry !== undefined
          return (
            <div key={s} className="grid grid-cols-[5rem_1fr_auto] gap-2 px-2 py-1 items-center">
              <span className="text-fg-faint">{SCOPE_LABELS[s].label}</span>
              <span className={`font-mono truncate ${entry?.winner ? 'text-accent' : 'text-fg-dim'}`}>
                {present ? valueToString(entry!.value) : <span className="text-fg-faint">—</span>}
              </span>
              {present ? (
                <button
                  onClick={() => onReset(s)}
                  className="text-[9px] px-1.5 py-0 rounded border border-line text-fg-faint uppercase tracking-wide hover:text-fg hover:bg-bg-hi"
                  title={`delete this key from ${SCOPE_LABELS[s].label}`}
                >
                  ↺
                </button>
              ) : (
                <span />
              )}
            </div>
          )
        })}
        <div className="grid grid-cols-[5rem_1fr_auto] gap-2 px-2 py-1 items-center">
          <span className="text-fg-faint">Default</span>
          <span className="font-mono text-fg-dim truncate">
            {defaultVal !== undefined ? valueToString(defaultVal) : <span className="text-fg-faint">—</span>}
          </span>
          <span />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ Expanded */

function CardDetails({
  keyName,
  node,
  info,
}: {
  keyName: string
  node: EffectiveNode | undefined
  info: SchemaInfo | null
}) {
  const isLeaf = node?.kind === 'leaf'
  const leaf = isLeaf ? (node as LeafNode) : null
  const description = resolveSettingDescription(keyName, info?.description)
  return (
    <div className="mt-2 space-y-2 text-xs">
      {description && (
        <p
          className={`text-fg-dim leading-relaxed whitespace-pre-wrap ${
            description.authored ? 'inline-block border-b border-dotted border-fg-faint/70 cursor-help' : ''
          }`}
          title={
            description.authored
              ? 'In-app-authored description — not from the official Claude Code schema'
              : undefined
          }
        >
          {description.text}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-fg-faint">
        {info?.type && (
          <>
            <dt>Type</dt>
            <dd className="text-fg-dim font-mono">
              {Array.isArray(info.type) ? info.type.join(' | ') : info.type}
            </dd>
          </>
        )}
        {info?.default !== undefined && (
          <>
            <dt>Default</dt>
            <dd className="text-fg-dim font-mono">{valueToString(info.default)}</dd>
          </>
        )}
        {info?.enum && (
          <>
            <dt>Options</dt>
            <dd className="text-fg-dim font-mono">{info.enum.map((v) => String(v)).join(' | ')}</dd>
          </>
        )}
        {leaf && (
          <>
            <dt>Current</dt>
            <dd className="font-mono">
              <span className="text-fg-dim">{valueToString(leaf.value)}</span>
              <span className="ml-2 text-fg-faint">
                from {SCOPE_LABELS[leaf.winner].label}
              </span>
            </dd>
          </>
        )}
        {leaf && leaf.shadowed.length > 0 && (
          <>
            <dt>Shadowed</dt>
            <dd className="space-y-0.5">
              {leaf.shadowed.map((s, i) => (
                <div key={i} className="font-mono text-fg-faint line-through">
                  {valueToString(s.value)} —{' '}
                  <span className="no-underline">{SCOPE_LABELS[s.scope].label}</span>
                </div>
              ))}
            </dd>
          </>
        )}
        {node?.kind === 'array' && (
          <>
            <dt>Accumulated</dt>
            <dd className="text-fg-dim">{node.items.length} items across all scopes</dd>
          </>
        )}
      </dl>
    </div>
  )
}

/* ----------------------------------------------------- Inline editors */

/**
 * String keys whose schema `examples` list the built-in choices: shown as a select (render 11's
 * Output style) with a 'custom…' entry so any other value stays writable.
 */
const SELECT_FROM_EXAMPLES: ReadonlySet<string> = new Set(['outputStyle'])
/** Select value for "not set in any file" — choosing it removes the key from the selected scope. */
const UNSET = '\u0000unset'
const CUSTOM = '\u0000custom'

const CONTROL =
  'w-full h-9 px-3 rounded-[10px] bg-bg border border-line font-mono text-[13px] text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint'

/**
 * ONE control per setting, by type, that writes the selected scope's file: a select for enums
 * (showing the effective value, else the schema default, else 'default' = unset), a Toggle for
 * booleans, a text / number input for strings / numbers (committed on blur or Enter).
 */
function Editor({
  keyName,
  node,
  info,
  onChange,
  targetLabel,
}: {
  keyName: string
  node: EffectiveNode | undefined
  info: SchemaInfo | null
  onChange: (v: unknown) => void
  targetLabel: string
}) {
  const isLeaf = node?.kind === 'leaf'
  const setValue = isLeaf ? (node as LeafNode).value : undefined
  const current = isLeaf ? setValue : info?.default
  const type = normalizeType(info?.type)
  const aria = `${humanizeKey(keyName)} — writes ${targetLabel}`

  if (type === 'boolean') {
    return (
      <span className="flex items-center gap-2" aria-label={aria}>
        <Toggle checked={current === true} onChange={(v) => onChange(v)} label={current === true ? 'on' : 'off'} />
      </span>
    )
  }

  if (info?.enum) {
    return <ChoiceSelect options={info.enum} value={current} onChange={onChange} aria={aria} allowCustom={false} />
  }

  if (type === 'string' && SELECT_FROM_EXAMPLES.has(keyName) && info?.examples?.length) {
    return <ChoiceSelect options={info.examples} value={current} onChange={onChange} aria={aria} allowCustom />
  }

  if (type === 'integer' || type === 'number') {
    return (
      <TextControl
        kind="number"
        initial={typeof current === 'number' ? String(current) : ''}
        aria={aria}
        onCommit={(text) => {
          if (text.trim() === '') return onChange(undefined)
          const n = type === 'integer' ? parseInt(text, 10) : parseFloat(text)
          if (!Number.isNaN(n)) onChange(n)
        }}
      />
    )
  }

  if (type === 'string') {
    return (
      <TextControl
        kind="text"
        initial={typeof current === 'string' ? current : ''}
        aria={aria}
        onCommit={(text) => onChange(text === '' ? undefined : text)}
      />
    )
  }

  // Array or object — too complex for one inline control.
  return (
    <div className="text-xs text-fg-faint">
      {node?.kind === 'array' ? `${node.items.length} items · ` : ''}edit in <span className="text-fg-dim">{'{ } Raw JSON'}</span>
    </div>
  )
}

/**
 * Enum / built-in-choice select. Shows the effective value (or the schema default); with
 * neither it shows 'default' — the unset entry, which removes the key from the selected scope.
 * `allowCustom` adds 'custom…' that swaps in a text input for any other value.
 */
function ChoiceSelect({
  options,
  value,
  onChange,
  aria,
  allowCustom,
}: {
  options: unknown[]
  value: unknown
  onChange: (v: unknown) => void
  aria: string
  allowCustom: boolean
}) {
  const [custom, setCustom] = useState(false)
  const hasValue = value !== undefined
  // The unset entry already reads 'default'; drop a literal 'default' choice so it isn't listed twice.
  const choices = options.filter((o) => hasValue || o !== 'default')
  const listed = hasValue && choices.some((o) => sameValue(o, value))
  const all = hasValue && !listed ? [value, ...choices] : choices
  if (custom) {
    return <TextControl kind="text" initial="" aria={aria} autoFocus onCommit={(t) => (t === '' ? setCustom(false) : onChange(t))} />
  }
  const selectedIdx = hasValue ? all.findIndex((o) => sameValue(o, value)) : -1
  return (
    <select
      aria-label={aria}
      value={selectedIdx >= 0 ? String(selectedIdx) : UNSET}
      onChange={(e) => {
        const v = e.target.value
        if (v === CUSTOM) return setCustom(true)
        onChange(v === UNSET ? undefined : all[Number(v)])
      }}
      className={CONTROL}
    >
      {!hasValue && <option value={UNSET}>default</option>}
      {all.map((o, i) => (
        <option key={i} value={String(i)}>
          {String(o)}
        </option>
      ))}
      {allowCustom && <option value={CUSTOM}>custom…</option>}
    </select>
  )
}

/** Text / number input: commits on blur or Enter, only when the text changed. */
function TextControl({
  kind,
  initial,
  aria,
  onCommit,
  autoFocus,
}: {
  kind: 'text' | 'number'
  initial: string
  aria: string
  onCommit: (text: string) => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState(initial)
  const commit = () => {
    if (text !== initial) onCommit(text)
  }
  return (
    <input
      type={kind}
      aria-label={aria}
      value={text}
      placeholder="not set"
      autoFocus={autoFocus}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(initial)
      }}
      className={CONTROL}
    />
  )
}

/* -------------------------------------------------------------- Helpers */

function normalizeType(t: SchemaInfo['type']): string | undefined {
  if (!t) return undefined
  if (Array.isArray(t)) {
    const nonNull = t.find((x) => x !== 'null')
    return nonNull ?? t[0]
  }
  return t
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function firstSentence(text: string): string {
  const trimmed = text.trim().split('\n')[0]
  const m = trimmed.match(/^([^.!?]+[.!?])/)
  if (m) return m[1]
  return trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed
}

function valueToString(v: unknown): string {
  if (typeof v === 'string') return v === '' ? '""' : JSON.stringify(v)
  if (v === null) return 'null'
  if (v === undefined) return '—'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  }
  return String(v)
}

