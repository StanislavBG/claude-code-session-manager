import { useMemo, useState } from 'react'
import type { Scope } from '../../lib/scopes'
import { SCOPE_LABELS } from '../../lib/scopes'
import type { EffectiveNode, LeafNode } from '../../lib/mergeScopes'
import type { SchemaResolver, SchemaInfo } from '../../lib/schemaLookup'
import { planGroups, planGroupRail, humanizeKey, type GroupRailEntry } from '../../lib/settingsGroups'
import { resolveSettingDescription } from '../../lib/settingsDescriptionFallbacks'
import { AlmanacIcon, type AlmanacIconName } from '../layout/AlmanacIcon'

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
 * group(s) as setting cards — name, mono key, description, the inline value editor, and a
 * `SourceLadder` (Default — User — Project — Local) marking where the effective value comes
 * from. Shared filter / showAdvanced / showUnset state lives in ONE place — `useEffectiveCards`.
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

export function SourceLadder({ node, defaultVal }: { node: EffectiveNode | undefined; defaultVal: unknown }) {
  const { effective, has } = settingSources(node, defaultVal)
  return (
    <div data-testid="source-ladder" className="flex items-center gap-1.5 whitespace-nowrap" aria-label="Where this value comes from">
      {LADDER.map(({ stage, label }, i) => {
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

function SettingCard({ keyName, node, info, targetScope, onOverride }: CardProps) {
  const [expanded, setExpanded] = useState(false)
  const title = humanizeKey(keyName)
  const isSet = node !== undefined
  const leafNode = node?.kind === 'leaf' ? node : null
  const defaultVal = info?.default
  const isDefault = leafNode && defaultVal !== undefined && sameValue(leafNode.value, defaultVal)
  const status = describeStatus({ isSet, leafNode, defaultVal, isDefault: !!isDefault, node })

  // Reset = "delete from the most-specific scope that has it" (the leaf's winner). Only
  // shown when the effective value differs from the schema default.
  const canReset = !!leafNode && !isDefault
  const description = resolveSettingDescription(keyName, info?.description)
  // Re-key the editor on the effective value / target file so its local draft follows the data.
  const editorKey = `${targetScope}:${leafNode ? JSON.stringify(leafNode.value) : '∅'}`

  return (
    <div
      data-testid="setting-card"
      data-key={keyName}
      className="px-[22px] py-4 rounded-[14px] bg-bg-hi border border-line"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,250px)_auto] items-center gap-x-7 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <h3 className="text-base font-semibold text-fg">{title}</h3>
            <span className="font-mono text-xs text-fg-faint">{keyName}</span>
            <StatusChip kind={status.kind} label={status.label} />
            {canReset && leafNode && (
              <button
                type="button"
                onClick={() => onOverride(undefined, leafNode.winner)}
                className="text-[9px] px-1.5 py-0 rounded border border-line bg-bg-elev text-fg-faint uppercase tracking-wide hover:text-fg hover:bg-bg"
                title={`reset · delete from ${SCOPE_LABELS[leafNode.winner].label}`}
              >
                ↺ reset
              </button>
            )}
            {info?.deprecated && (
              <span className="text-[9px] px-1 py-0 rounded border border-yellow-900/40 bg-yellow-950/30 text-yellow-500/80 uppercase tracking-wide">
                deprecated
              </span>
            )}
            {info?.required && !isSet && (
              <span className="text-[9px] px-1 py-0 rounded border border-red-900/40 bg-red-950/30 text-red-400/80 uppercase tracking-wide">
                required
              </span>
            )}
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
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-2 text-xs text-fg-faint hover:text-fg underline-offset-2 hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? 'less' : 'details'}
          </button>
        </div>
        <div className="min-w-0 text-xs">
          <Editor key={editorKey} keyName={keyName} node={node} info={info} onChange={(v) => onOverride(v)} targetScope={targetScope} />
        </div>
        <SourceLadder node={node} defaultVal={defaultVal} />
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-line/60">
          {leafNode && <DriftTable leaf={leafNode} defaultVal={defaultVal} onReset={(s) => onOverride(undefined, s)} />}
          <CardDetails keyName={keyName} node={node} info={info} />
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

function Editor({
  node,
  info,
  onChange,
  targetScope,
}: {
  keyName: string
  node: EffectiveNode | undefined
  info: SchemaInfo | null
  onChange: (v: unknown) => void
  targetScope: Scope
}) {
  const isLeaf = node?.kind === 'leaf'
  const current = isLeaf ? (node as LeafNode).value : info?.default
  const type = normalizeType(info?.type)

  // Boolean → two-state switch
  if (type === 'boolean') {
    const on = current === true
    return (
      <div className="flex items-center gap-2">
        <span className="text-fg-faint">Set to:</span>
        <div className="inline-flex rounded border border-line overflow-hidden">
          {[
            { v: true, label: 'on' },
            { v: false, label: 'off' },
          ].map(({ v, label }) => (
            <button
              key={label}
              onClick={() => onChange(v)}
              className={`px-3 py-0.5 text-xs transition-colors ${
                on === v
                  ? 'bg-accent text-bg'
                  : 'bg-bg-elev text-fg-dim hover:bg-bg-hi hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-fg-faint">→ {SCOPE_LABELS[targetScope].label}</span>
      </div>
    )
  }

  // Enum → chip selection
  if (info?.enum) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-fg-faint">Choose:</span>
        {info.enum.map((v) => {
          const selected = sameValue(current, v)
          return (
            <button
              key={String(v)}
              onClick={() => onChange(v)}
              className={`px-2 py-0.5 text-xs rounded border ${
                selected
                  ? 'bg-accent text-bg border-accent'
                  : 'bg-bg-elev text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
              }`}
            >
              {String(v)}
            </button>
          )
        })}
        <span className="text-fg-faint">→ {SCOPE_LABELS[targetScope].label}</span>
      </div>
    )
  }

  // Number → input
  if (type === 'integer' || type === 'number') {
    return (
      <NumberEditor
        value={typeof current === 'number' ? current : undefined}
        integer={type === 'integer'}
        onCommit={onChange}
        target={SCOPE_LABELS[targetScope].label}
      />
    )
  }

  // String → input
  if (type === 'string') {
    return (
      <StringEditor
        value={typeof current === 'string' ? current : ''}
        onCommit={onChange}
        target={SCOPE_LABELS[targetScope].label}
      />
    )
  }

  // Array or object — too complex for inline; provide a nudge.
  return (
    <div className="text-fg-faint">
      Complex value ({type ?? 'object/array'}) — use the{' '}
      <span className="text-fg-dim">{'{ } Raw JSON'}</span> to edit.
    </div>
  )
}

function NumberEditor({
  value,
  integer,
  onCommit,
  target,
}: {
  value: number | undefined
  integer: boolean
  onCommit: (v: number) => void
  target: string
}) {
  const [text, setText] = useState(value !== undefined ? String(value) : '')
  const commit = () => {
    const n = integer ? parseInt(text, 10) : parseFloat(text)
    if (!Number.isNaN(n)) onCommit(n)
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-faint">Set to:</span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="w-24 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
      />
      <button
        onClick={commit}
        className="px-2 py-0.5 text-xs border border-accent/50 rounded text-accent hover:bg-accent hover:text-bg"
      >
        save → {target}
      </button>
    </div>
  )
}

function StringEditor({
  value,
  onCommit,
  target,
}: {
  value: string
  onCommit: (v: string) => void
  target: string
}) {
  const [text, setText] = useState(value)
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <span className="text-fg-faint shrink-0">Set to:</span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(text)
        }}
        className="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
      />
      <button
        onClick={() => onCommit(text)}
        className="shrink-0 px-2 py-0.5 text-xs border border-accent/50 rounded text-accent hover:bg-accent hover:text-bg"
      >
        save → {target}
      </button>
    </div>
  )
}

/* --------------------------------------------------------- Status chip */

type StatusKind = 'set' | 'default' | 'unset' | 'override' | 'accumulated'

function describeStatus({
  isSet,
  leafNode,
  defaultVal,
  isDefault,
  node,
}: {
  isSet: boolean
  leafNode: LeafNode | null
  defaultVal: unknown
  isDefault: boolean
  node: EffectiveNode | undefined
}): { kind: StatusKind; label: string } {
  if (!isSet) {
    if (defaultVal !== undefined) return { kind: 'default', label: `using default: ${valueToString(defaultVal)}` }
    return { kind: 'unset', label: 'not configured' }
  }
  if (node?.kind === 'array') return { kind: 'accumulated', label: `${node.items.length} items` }
  if (node?.kind === 'object') return { kind: 'set', label: 'configured' }
  if (leafNode) {
    if (isDefault) return { kind: 'default', label: `= default · ${SCOPE_LABELS[leafNode.winner].label}` }
    if (leafNode.shadowed.length > 0)
      return { kind: 'override', label: `overriding ${leafNode.shadowed.length} scope(s)` }
    return { kind: 'set', label: `set in ${SCOPE_LABELS[leafNode.winner].label}` }
  }
  return { kind: 'set', label: 'configured' }
}

function StatusChip({ kind, label }: { kind: StatusKind; label: string }) {
  const cls = {
    set: 'bg-accent/15 text-accent border-accent/30',
    default: 'bg-bg-hi text-fg-dim border-line',
    unset: 'bg-bg-elev text-fg-faint border-line',
    override: 'bg-purple-950/30 text-purple-400/80 border-purple-900/40',
    accumulated: 'bg-blue-950/30 text-blue-400/80 border-blue-900/40',
  }[kind]
  return (
    <span
      className={`text-[9px] px-1.5 py-0 rounded border uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
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

