import { useMemo, useState } from 'react'
import type { Scope } from '../../lib/scopes'
import { SCOPE_LABELS } from '../../lib/scopes'
import type {
  EffectiveNode,
  LeafNode,
  ObjectNode,
  ArrayNode,
} from '../../lib/mergeScopes'
import type { SchemaResolver, SchemaInfo } from '../../lib/schemaLookup'

/**
 * Schema-aware tree view of a merged-scope node.
 *
 *  - Each row shows provenance (winning scope badge) + description/type
 *    from the JSON schema when available.
 *  - "Ghost" rows are rendered for keys that exist in the schema but aren't
 *    set in any scope — showing their default, description, and a "set"
 *    button that writes the default into the target scope's draft.
 *  - Override button on set leaves copies the winning value into the target
 *    scope's draft (no-op if the winner is already the target).
 */

interface Props {
  node: EffectiveNode
  targetScope: Scope
  onOverride: (path: string[], value: unknown) => void
  schema?: SchemaResolver
  /** Prefix label for the root object ("permissions", "hooks"). */
  rootLabel?: string
}

export function EffectiveTree({ node, targetScope, onOverride, schema, rootLabel }: Props) {
  const [filter, setFilter] = useState('')
  const [showGhosts, setShowGhosts] = useState(true)

  const rootPath: string[] = []
  const isEmpty = node.kind === 'object' && Object.keys(node.children).length === 0
  const schemaRootKeys = schema?.rootKeys() ?? []
  const hasSchema = schemaRootKeys.length > 0

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-line bg-bg-elev px-3 py-1.5 flex items-center gap-2 text-xs">
        <span className="text-fg-faint">
          merged · overrides → <span className="text-fg-dim">{SCOPE_LABELS[targetScope].label}</span>
        </span>
        {hasSchema && (
          <label className="flex items-center gap-1 text-fg-faint cursor-pointer">
            <input
              type="checkbox"
              checked={showGhosts}
              onChange={(e) => setShowGhosts(e.target.checked)}
              className="accent-accent"
            />
            show unset keys
          </label>
        )}
        <div className="flex-1" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter keys or descriptions…"
          className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg w-56"
        />
      </div>
      <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs">
        {isEmpty && !showGhosts ? (
          <div className="text-fg-faint italic px-2 py-4">
            no settings resolved — all scope files empty or missing
          </div>
        ) : (
          <NodeRow
            node={node}
            path={rootPath}
            label={rootLabel ?? '(root)'}
            targetScope={targetScope}
            onOverride={onOverride}
            filter={filter}
            depth={0}
            schema={schema}
            showGhosts={showGhosts}
            defaultOpen
          />
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------- row dispatch */

interface RowProps {
  node: EffectiveNode
  path: string[]
  label: string
  targetScope: Scope
  onOverride: (path: string[], value: unknown) => void
  filter: string
  depth: number
  schema?: SchemaResolver
  showGhosts: boolean
  defaultOpen?: boolean
}

function NodeRow(props: RowProps) {
  if (props.node.kind === 'object') return <ObjectRow {...props} node={props.node} />
  if (props.node.kind === 'array') return <ArrayRow {...props} node={props.node} />
  return <LeafRow {...props} node={props.node} />
}

function matchesFilter(text: string, needle: string): boolean {
  if (!needle.trim()) return true
  return text.toLowerCase().includes(needle.toLowerCase())
}

function rowMatches(path: string[], info: SchemaInfo | null, filter: string): boolean {
  if (!filter.trim()) return true
  if (path.some((p) => matchesFilter(p, filter))) return true
  if (info?.description && matchesFilter(info.description, filter)) return true
  return false
}

/* ---------------------------------------------------------------- object */

function ObjectRow({
  node,
  path,
  label,
  targetScope,
  onOverride,
  filter,
  depth,
  schema,
  showGhosts,
  defaultOpen,
}: RowProps & { node: ObjectNode }) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2)
  const info = schema?.at(path) ?? null

  // Merge schema-known children with present children. Ghost = known but unset.
  const presentKeys = new Set(Object.keys(node.children))
  const schemaKeys: string[] = showGhosts ? info?.knownChildren ?? [] : []
  const allKeys = Array.from(new Set([...presentKeys, ...schemaKeys])).sort()

  // Filter: keep this branch if any descendant matches.
  const visibleKeys = useMemo(() => {
    if (!filter.trim()) return allKeys
    return allKeys.filter((k) => {
      const childInfo = schema?.at([...path, k]) ?? null
      if (rowMatches([...path, k], childInfo, filter)) return true
      if (presentKeys.has(k))
        return branchMatches(node.children[k], [...path, k], filter, schema)
      return false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKeys.join(','), filter, node, path.join('.'), schema])

  if (filter.trim() && visibleKeys.length === 0 && !rowMatches(path, info, filter)) return null

  // Root object has no header row; descend straight into children.
  if (path.length === 0) {
    return (
      <div>
        {visibleKeys.map((k) => renderChild(k))}
      </div>
    )
  }

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 hover:bg-bg-elev/50 rounded cursor-pointer"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="text-fg-faint w-3 shrink-0">{open ? '▾' : '▸'}</span>
        <span className="text-fg">{label}</span>
        <span className="text-fg-faint">
          {' {'}
          {presentKeys.size}
          {schemaKeys.length > presentKeys.size
            ? `/${new Set([...presentKeys, ...schemaKeys]).size}`
            : ''}
          {'}'}
        </span>
        {info?.description && (
          <span className="text-fg-faint truncate max-w-md" title={info.description}>
            — {info.description}
          </span>
        )}
      </div>
      {open && visibleKeys.map((k) => renderChild(k))}
    </div>
  )

  function renderChild(k: string) {
    if (presentKeys.has(k)) {
      return (
        <NodeRow
          key={k}
          node={node.children[k]}
          path={[...path, k]}
          label={k}
          targetScope={targetScope}
          onOverride={onOverride}
          filter={filter}
          depth={depth + 1}
          schema={schema}
          showGhosts={showGhosts}
        />
      )
    }
    const childInfo = schema?.at([...path, k]) ?? null
    if (!childInfo) return null
    return (
      <GhostRow
        key={k}
        path={[...path, k]}
        label={k}
        info={childInfo}
        targetScope={targetScope}
        onSet={onOverride}
        depth={depth + 1}
        filter={filter}
      />
    )
  }
}

function branchMatches(
  node: EffectiveNode,
  path: string[],
  filter: string,
  schema: SchemaResolver | undefined
): boolean {
  const info = schema?.at(path) ?? null
  if (rowMatches(path, info, filter)) return true
  if (node.kind !== 'object') return false
  for (const k of Object.keys(node.children)) {
    if (branchMatches(node.children[k], [...path, k], filter, schema)) return true
  }
  return false
}

/* ----------------------------------------------------------------- array */

function ArrayRow({
  node,
  path,
  label,
  filter,
  depth,
  schema,
}: RowProps & { node: ArrayNode }) {
  const [open, setOpen] = useState(true)
  const info = schema?.at(path) ?? null
  if (!rowMatches(path, info, filter)) return null
  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 hover:bg-bg-elev/50 rounded cursor-pointer"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="text-fg-faint w-3 shrink-0">{open ? '▾' : '▸'}</span>
        <span className="text-fg">{label}</span>
        <span className="text-fg-faint"> [{node.items.length}]</span>
        <Badge tone="warn">accumulated</Badge>
        {info?.description && (
          <span className="text-fg-faint truncate max-w-md" title={info.description}>
            — {info.description}
          </span>
        )}
      </div>
      {open &&
        node.items.map((it, i) => (
          <div
            key={i}
            className="flex items-start gap-2 py-0.5"
            style={{ paddingLeft: (depth + 1) * 14 }}
          >
            <span className="text-fg-faint w-3 shrink-0" />
            <span className="text-fg-faint">{i}:</span>
            <span className="text-fg-dim truncate max-w-xl">{valueToString(it.value)}</span>
            <ScopeBadge scope={it.fromScope} />
          </div>
        ))}
    </div>
  )
}

/* ------------------------------------------------------------------ leaf */

function LeafRow({
  node,
  path,
  label,
  targetScope,
  onOverride,
  filter,
  depth,
  schema,
}: RowProps & { node: LeafNode }) {
  const [open, setOpen] = useState(false)
  const info = schema?.at(path) ?? null
  if (!rowMatches(path, info, filter)) return null
  const canOverride = node.winner !== targetScope
  const hasShadows = node.shadowed.length > 0

  return (
    <div>
      <div
        className="group flex items-center gap-2 py-0.5 hover:bg-bg-elev/50 rounded"
        style={{ paddingLeft: depth * 14 }}
      >
        <span
          className={`w-3 shrink-0 ${hasShadows ? 'text-fg-faint cursor-pointer' : ''}`}
          onClick={() => hasShadows && setOpen(!open)}
        >
          {hasShadows ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="text-fg">{label}:</span>
        <span className="text-fg-dim truncate max-w-md">{valueToString(node.value)}</span>
        <ScopeBadge scope={node.winner} />
        {info?.deprecated && <Badge tone="warn">deprecated</Badge>}
        {info?.default !== undefined && sameValue(node.value, info.default) && (
          <Badge tone="dim">= default</Badge>
        )}
        {node.typeMismatch && (
          <span className="text-yellow-500/80" title="shadowed scopes have a different value type">
            ⚠
          </span>
        )}
        {info?.description && (
          <span className="text-fg-faint truncate max-w-md" title={info.description}>
            — {info.description}
          </span>
        )}
        <div className="flex-1" />
        {info?.enum && <EnumHint values={info.enum} />}
        <button
          disabled={!canOverride}
          onClick={() => onOverride(path, node.value)}
          className={`opacity-0 group-hover:opacity-100 px-1.5 py-0 text-[10px] border rounded transition-opacity ${
            canOverride
              ? 'border-accent/50 text-accent hover:bg-accent hover:text-bg'
              : 'border-line text-fg-faint cursor-not-allowed'
          }`}
          title={
            canOverride
              ? `copy into ${SCOPE_LABELS[targetScope].label} draft`
              : `already winning in ${SCOPE_LABELS[targetScope].label}`
          }
        >
          override
        </button>
      </div>
      {open &&
        node.shadowed.map((s, i) => (
          <div
            key={i}
            className="flex items-center gap-2 py-0.5 text-fg-faint line-through"
            style={{ paddingLeft: (depth + 1) * 14 + 12 }}
          >
            <span>shadowed:</span>
            <span className="truncate max-w-xl">{valueToString(s.value)}</span>
            <ScopeBadge scope={s.scope} dim />
          </div>
        ))}
    </div>
  )
}

/* ----------------------------------------------------------------- ghost */

function GhostRow({
  path,
  label,
  info,
  targetScope,
  onSet,
  depth,
  filter,
}: {
  path: string[]
  label: string
  info: SchemaInfo
  targetScope: Scope
  onSet: (path: string[], value: unknown) => void
  depth: number
  filter: string
}) {
  if (!rowMatches(path, info, filter)) return null
  const defaultVal = info.default !== undefined ? info.default : defaultForType(info.type)
  const typeLabel = Array.isArray(info.type) ? info.type.join('|') : info.type ?? '?'
  return (
    <div
      className="group flex items-center gap-2 py-0.5 hover:bg-bg-elev/50 rounded opacity-60"
      style={{ paddingLeft: depth * 14 }}
    >
      <span className="w-3 shrink-0" />
      <span className="text-fg-dim">{label}</span>
      <Badge tone="dim">{typeLabel}</Badge>
      {info.required && <Badge tone="warn">required</Badge>}
      {info.default !== undefined && (
        <span className="text-fg-faint">default: {valueToString(info.default)}</span>
      )}
      {info.description && (
        <span className="text-fg-faint truncate max-w-md" title={info.description}>
          — {info.description}
        </span>
      )}
      <div className="flex-1" />
      {info.enum && <EnumHint values={info.enum} />}
      <button
        onClick={() => onSet(path, defaultVal)}
        className="opacity-0 group-hover:opacity-100 px-1.5 py-0 text-[10px] border border-accent/50 rounded text-accent hover:bg-accent hover:text-bg transition-opacity"
        title={`write to ${SCOPE_LABELS[targetScope].label} draft`}
      >
        set
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- atoms */

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function defaultForType(t: SchemaInfo['type']): unknown {
  const kind = Array.isArray(t) ? t[0] : t
  switch (kind) {
    case 'boolean':
      return false
    case 'integer':
    case 'number':
      return 0
    case 'string':
      return ''
    case 'array':
      return []
    case 'object':
      return {}
    case 'null':
      return null
    default:
      return null
  }
}

function valueToString(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === null) return 'null'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 100 ? s.slice(0, 100) + '…' : s
  }
  return String(v)
}

function ScopeBadge({ scope, dim }: { scope: Scope; dim?: boolean }) {
  const cls =
    scope === 'user'
      ? 'bg-bg-hi text-fg-dim border-line'
      : scope === 'project'
        ? 'bg-blue-950/30 text-blue-400/80 border-blue-900/40'
        : 'bg-purple-950/30 text-purple-400/80 border-purple-900/40'
  return (
    <span
      className={`text-[10px] px-1 py-0 rounded border uppercase tracking-wide shrink-0 ${cls} ${
        dim ? 'opacity-60' : ''
      }`}
    >
      {SCOPE_LABELS[scope].label}
    </span>
  )
}

function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode
  tone?: 'default' | 'warn' | 'dim'
}) {
  const cls = {
    default: 'bg-bg-hi text-fg-dim border-line',
    warn: 'bg-yellow-950/30 text-yellow-500/80 border-yellow-900/40',
    dim: 'bg-bg-elev text-fg-faint border-line',
  }[tone]
  return (
    <span
      className={`text-[10px] px-1 py-0 rounded border uppercase tracking-wide shrink-0 ${cls}`}
    >
      {children}
    </span>
  )
}

function EnumHint({ values }: { values: unknown[] }) {
  const text = values.map((v) => String(v)).join(' | ')
  return (
    <span
      className="text-[10px] text-fg-faint truncate max-w-xs"
      title={`allowed: ${text}`}
    >
      ∈ {text.length > 30 ? text.slice(0, 30) + '…' : text}
    </span>
  )
}
