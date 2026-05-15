import { useMemo, useState } from 'react'
import type { Scope } from '../../lib/scopes'
import { SCOPE_LABELS } from '../../lib/scopes'
import type { EffectiveNode, LeafNode } from '../../lib/mergeScopes'
import type { SchemaResolver, SchemaInfo } from '../../lib/schemaLookup'
import { planGroups, humanizeKey } from '../../lib/settingsGroups'

type OnOverride = (path: string[], value: unknown, intoScope?: Scope) => void

/** The four columns surfaced by the drift indicator. `default` is sourced
 *  from the JSON Schema, the other three from the merged LeafNode. */
const DRIFT_SCOPES: ReadonlyArray<Scope | 'default'> = ['user', 'project', 'local', 'default']

const SCOPE_LABELS_SHORT: Record<Scope | 'default', string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  default: 'default',
}

/**
 * Grandma-friendly view of merged settings.
 *
 * Groups keys into themed sections (see settingsGroups.ts), renders each
 * setting as an expandable card with one-line prose + inline editors for
 * common types. Clicking "Explain" opens the full description, shadowed
 * values, and enum choices. Everything else (arrays, nested objects) gets
 * a "Edit in Raw view" fallback.
 */

interface Props {
  node: EffectiveNode
  targetScope: Scope
  onOverride: OnOverride
  schema: SchemaResolver
}

export function EffectiveCards({ node, targetScope, onOverride, schema }: Props) {
  const [filter, setFilter] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showUnset, setShowUnset] = useState(true)

  const rootNode = node.kind === 'object' ? node : null
  const presentKeys = rootNode ? Object.keys(rootNode.children) : []
  const knownKeys = schema.rootKeys()
  const allKeys = new Set<string>([...presentKeys, ...knownKeys])

  const groups = useMemo(() => planGroups(allKeys), [Array.from(allKeys).sort().join(',')])

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

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-3 text-xs">
        <span className="text-fg-faint">
          writing overrides to{' '}
          <span className="text-fg-dim font-medium">{SCOPE_LABELS[targetScope].label}</span>
        </span>
        <label className="flex items-center gap-1 text-fg-faint cursor-pointer">
          <input
            type="checkbox"
            checked={showUnset}
            onChange={(e) => setShowUnset(e.target.checked)}
            className="accent-accent"
          />
          show not-yet-configured
        </label>
        <label className="flex items-center gap-1 text-fg-faint cursor-pointer">
          <input
            type="checkbox"
            checked={showAdvanced}
            onChange={(e) => setShowAdvanced(e.target.checked)}
            className="accent-accent"
          />
          show advanced
        </label>
        <div className="flex-1" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="search settings…"
          className="bg-bg border border-line rounded px-2 py-1 text-xs text-fg w-64"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {visibleGroups.map((g) => (
          <Section
            key={g.id}
            title={g.title}
            summary={g.summary}
            advanced={g.advanced}
          >
            {g.keys.map((k) => {
              const child = rootNode?.children[k]
              const info = schema.at([k])
              return (
                <SettingCard
                  key={k}
                  keyName={k}
                  node={child}
                  info={info}
                  targetScope={targetScope}
                  onOverride={(v, intoScope) => onOverride([k], v, intoScope)}
                />
              )
            })}
          </Section>
        ))}
        {visibleGroups.length === 0 && (
          <div className="px-6 py-12 text-center text-fg-faint text-sm">
            no settings match "{filter}"
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Section */

function Section({
  title,
  summary,
  advanced,
  children,
}: {
  title: string
  summary: string
  advanced?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section className="border-b border-line">
      <header
        className="px-4 py-2.5 bg-bg-elev/40 cursor-pointer hover:bg-bg-elev flex items-center gap-3"
        onClick={() => setOpen(!open)}
      >
        <span className="text-fg-faint w-3">{open ? '▾' : '▸'}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-fg text-sm font-medium">{title}</h2>
            {advanced && (
              <span className="text-[9px] px-1.5 py-0 rounded border border-yellow-900/40 bg-yellow-950/30 text-yellow-500/80 uppercase tracking-wide">
                advanced
              </span>
            )}
          </div>
          <p className="text-fg-faint text-xs">{summary}</p>
        </div>
      </header>
      {open && <div className="divide-y divide-line/60">{children}</div>}
    </section>
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
  const [driftOpen, setDriftOpen] = useState(false)
  const title = humanizeKey(keyName)
  const isSet = node !== undefined
  const isLeaf = node?.kind === 'leaf'
  const leafNode = isLeaf ? (node as LeafNode) : null
  const isObjectOrArray = node?.kind === 'object' || node?.kind === 'array'
  const defaultVal = info?.default
  const isDefault =
    leafNode && defaultVal !== undefined && sameValue(leafNode.value, defaultVal)

  const status = describeStatus({
    isSet,
    leafNode,
    defaultVal,
    isDefault: !!isDefault,
    node,
  })

  // Drift across scopes is precomputed by mergeScopes — winner + shadowed[] —
  // so we just surface what's already there rather than re-merging here.
  const driftScopes = collectDriftScopes(leafNode, defaultVal)
  const hasDrift = driftScopes.length >= 2

  // Reset = "delete from the most-specific scope that has it". For a leaf
  // that's the winner. Only show when effective != default (otherwise the
  // value already matches the schema default).
  const canReset = !!leafNode && !isDefault

  return (
    <div className="px-4 py-3 hover:bg-bg-elev/20">
      <div className="flex items-start gap-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-fg-faint hover:text-fg w-3 mt-0.5"
          title={expanded ? 'collapse' : 'expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-fg text-sm">{title}</h3>
            <StatusChip kind={status.kind} label={status.label} />
            {hasDrift && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (!expanded) setExpanded(true)
                  setDriftOpen((v) => !v)
                }}
                className="text-[9px] px-1.5 py-0 rounded border border-blue-900/40 bg-blue-950/30 text-blue-300/90 uppercase tracking-wide hover:bg-blue-900/40"
                title="this key is defined in multiple scopes — click to expand"
              >
                drift · {driftScopes.map((s) => SCOPE_LABELS_SHORT[s]).join(' · ')}
              </button>
            )}
            {canReset && leafNode && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  // Write undefined into the winning scope's draft. setAtPath
                  // sets base[head] = undefined, which JSON.stringify drops,
                  // achieving an in-scope delete on save.
                  onOverride(undefined, leafNode.winner)
                }}
                className="text-[9px] px-1.5 py-0 rounded border border-line bg-bg-elev text-fg-faint uppercase tracking-wide hover:text-fg hover:bg-bg-hi"
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
          {info?.description && (
            <p className="text-fg-dim text-xs mt-0.5 leading-relaxed">
              {firstSentence(info.description)}
            </p>
          )}
          {expanded && driftOpen && leafNode && (
            <DriftTable
              leaf={leafNode}
              defaultVal={defaultVal}
              onReset={(s) => onOverride(undefined, s)}
            />
          )}
          {expanded && (
            <CardDetails
              keyName={keyName}
              node={node}
              info={info}
              targetScope={targetScope}
              onOverride={(v) => onOverride(v)}
            />
          )}
        </div>
        <div className="shrink-0">
          {!expanded && (
            <QuickControl
              node={node}
              info={info}
              onSet={(v) => {
                onOverride(v)
              }}
              disabled={isObjectOrArray && isSet}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function collectDriftScopes(
  leaf: LeafNode | null,
  defaultVal: unknown,
): Array<Scope | 'default'> {
  if (!leaf) return []
  const seen = new Set<Scope | 'default'>()
  seen.add(leaf.winner)
  for (const s of leaf.shadowed) seen.add(s.scope)
  if (defaultVal !== undefined) seen.add('default')
  // Preserve canonical order (user → project → local → default).
  return DRIFT_SCOPES.filter((s) => seen.has(s))
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
  targetScope,
  onOverride,
}: {
  keyName: string
  node: EffectiveNode | undefined
  info: SchemaInfo | null
  targetScope: Scope
  onOverride: (value: unknown) => void
}) {
  const isLeaf = node?.kind === 'leaf'
  const leaf = isLeaf ? (node as LeafNode) : null
  return (
    <div className="mt-3 space-y-2 text-xs">
      {info?.description && (
        <p className="text-fg-dim leading-relaxed whitespace-pre-wrap">{info.description}</p>
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
      <div className="pt-2 flex items-center gap-2 flex-wrap border-t border-line/60">
        <Editor
          keyName={keyName}
          node={node}
          info={info}
          onChange={onOverride}
          targetScope={targetScope}
        />
      </div>
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
      <span className="text-fg-dim">Raw</span> tab to edit.
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

/* -------------------------------------------------- Quick control (collapsed) */

function QuickControl({
  node,
  info,
  onSet,
  disabled,
}: {
  node: EffectiveNode | undefined
  info: SchemaInfo | null
  onSet: (v: unknown) => void
  disabled?: boolean
}) {
  const isLeaf = node?.kind === 'leaf'
  const type = normalizeType(info?.type)
  if (disabled) return null
  if (type === 'boolean') {
    const on = isLeaf && (node as LeafNode).value === true
    return (
      <button
        onClick={() => onSet(!on)}
        className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
          on
            ? 'bg-accent/15 text-accent border-accent/40 hover:bg-accent hover:text-bg'
            : 'bg-bg-elev text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
        }`}
        title="toggle"
      >
        {on ? 'on' : 'off'}
      </button>
    )
  }
  return null
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

