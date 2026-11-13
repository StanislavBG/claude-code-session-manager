/**
 * Review MD network's LINK MAP and FINDINGS cards (Project Home v2 DESIGN_SPEC §6), drawn from
 * the one `window.api.projectPages.mdNetwork` scan ToolsPane fetches. Purely presentational.
 *
 * `layoutMdNetwork` is the pure layout: four columns by link depth from the root CLAUDE.md
 * (x = 44 / 232 / 470 / 650 of the 760×392 viewBox, depth 3+ in the last), each column's rows
 * spread evenly within y 16..376. Rows keep the scan's walk order, so a doc sits near the doc
 * that first linked it. `opts.minRowGap` grows the height to fit the fullest column at that gap
 * (never below 392); rows then spread within 16..height-16. More than 8 docs of one folder in a column collapse into one
 * `<folder>/ · <n>` node (its edges re-routed, links inside it dropped) unless `opts.expanded` holds
 * that folder node's id. A broken link's target
 * gets a dashed accent Missing node one column right of the linking doc, which is drawn as a
 * Finding; each orphan group is an unlinked dashed node at the foot of the last column.
 *
 * Hovering a node dims all but it and its neighbours and captions it; hovering a finding lights
 * its nodes. Colours are token classes written as whole literals (Tailwind JIT); geometry is
 * plain SVG attributes.
 */
import { useMemo, useState, type KeyboardEvent } from 'react'
import { toast } from '../../../../state/toast'
import type { MdNetwork, MdNetworkFinding } from '../../../../../preload/api'

const COLUMN_X = [44, 232, 470, 650] as const
const LAST_COLUMN = COLUMN_X.length - 1
const ROW_TOP = 16
const MAP_WIDTH = 760
const MAP_HEIGHT = 392
/** A column holding more than this many docs of one folder draws them as one folder node. */
const COLLAPSE_OVER = 8
/** Label room per column, in characters of the 10.5px mono label. */
const LABEL_MAX = [14, 34, 26, 15] as const
const HINT = 'Hover a doc to see where it lives and what links to it.'

export type MdMapNodeKind = 'hub' | 'owner' | 'doc' | 'folder' | 'missing' | 'orphan'

/** One drawn node: a doc, a collapsed folder, a missing link target, or an orphan group. */
export interface MdMapNode {
  /** The doc path; `folder:<column>:<dir>`, `missing:<target>` or `orphan:<where>` otherwise. */
  id: string
  kind: MdMapNodeKind
  column: number
  x: number
  y: number
  /** The short label drawn beside the node. */
  label: string
  /** The caption path: the doc path, `<dir>/ (<n> docs)`, `<target> (missing)` or `<where> (<n> docs)`. */
  path: string
  /** A doc's own counts from the scan; for a folder, the links crossing its edge. */
  linksOut: number
  linkedFrom: number
  /** Docs the node stands for: 1 for a doc, n for a folder or orphan group, 0 for a missing target. */
  count: number
  /** The linking doc of a broken link, drawn as a Finding. */
  flagged: boolean
}

/** One drawn link between two map nodes; links both ways between the same pair draw once. */
export interface MdMapEdge {
  from: string
  to: string
  broken: boolean
  /** SVG path data: a cubic bezier. */
  d: string
}

export interface MdLinkMapLayout {
  /** By column, then top to bottom. */
  nodes: MdMapNode[]
  edges: MdMapEdge[]
  /** The map nodes each finding marks, in the scan's `findings` order. */
  findingNodes: string[][]
  /** The canvas the coordinates live in: 760 wide; 392 tall unless `minRowGap` grew it. */
  width: number
  height: number
}

export interface LayoutOptions {
  /** Folder node ids (`folder:<column>:<dir>`) whose docs draw as individual nodes. */
  expanded?: ReadonlySet<string>
  /** The least vertical gap between rows; the canvas grows to keep it. */
  minRowGap?: number
}

interface DraftNode extends Omit<MdMapNode, 'x' | 'y'> {
  /** Walk index of the first link reaching the node; sorts the column. */
  order: number
}

const round1 = (n: number) => Math.round(n * 10) / 10
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const columnOf = (depth: number) => Math.min(Math.max(Math.floor(depth), 0), LAST_COLUMN)

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i)
}

/** `name` + `suffix` within `max` characters; the name gives way first. */
function fit(name: string, max: number, suffix = ''): string {
  if (name.length + suffix.length <= max) return name + suffix
  return `${name.slice(0, Math.max(1, max - suffix.length - 1))}…${suffix}`
}

/**
 * `parent/file.md` when it fits; else the parent clipped from the left (`…operations/CLAUDE.md`,
 * so two CLAUDE.md never read alike); else `file.md`, clipped if need be.
 */
function docLabel(path: string, max: number): string {
  const parts = path.split('/').filter((p) => p !== '')
  const file = parts[parts.length - 1] ?? path
  if (parts.length < 2) return fit(file, max)
  const parent = parts[parts.length - 2]
  if (parent.length + 1 + file.length <= max) return `${parent}/${file}`
  const room = max - file.length - 2 // the '…' and the '/'
  return room >= 3 ? `…${parent.slice(-room)}/${file}` : fit(file, max)
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  if (a.x === b.x) {
    // Same column: bow out to the right instead of running through the column's other nodes.
    const cx = round1(a.x + Math.min(72, 18 + Math.abs(b.y - a.y) * 0.3))
    return `M${a.x} ${a.y} C${cx} ${a.y} ${cx} ${b.y} ${b.x} ${b.y}`
  }
  const mx = round1((a.x + b.x) / 2)
  return `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`
}

/** Pure: where every node and edge of one scan goes on the 760-wide map (392 tall by default). */
export function layoutMdNetwork(net: MdNetwork, opts: LayoutOptions = {}): MdLinkMapLayout {
  const expanded = opts.expanded
  // The scan lists edges in walk order, so the first edge into a target is the one that found it.
  const firstIn = new Map<string, number>()
  net.edges.forEach((e, i) => {
    const target = e.broken ? `missing:${e.to}` : e.to
    if (!firstIn.has(target)) firstIn.set(target, i)
  })

  const perFolder = new Map<string, number>()
  for (const n of net.nodes) {
    const key = `${columnOf(n.depth)}\0${dirOf(n.path)}`
    perFolder.set(key, (perFolder.get(key) ?? 0) + 1)
  }

  const drafts = new Map<string, DraftNode>()
  /** Doc path → the map node drawing it. */
  const nodeOf = new Map<string, string>()
  for (const n of net.nodes) {
    const column = columnOf(n.depth)
    const dir = dirOf(n.path)
    const order = firstIn.get(n.id) ?? -1
    const id = `folder:${column}:${dir}`
    if ((perFolder.get(`${column}\0${dir}`) ?? 0) > COLLAPSE_OVER && !expanded?.has(id)) {
      nodeOf.set(n.id, id)
      const group = drafts.get(id)
      const count = (group?.count ?? 0) + 1
      const name = `${dir.slice(dir.lastIndexOf('/') + 1)}/`
      drafts.set(id, {
        id,
        kind: 'folder',
        column,
        label: fit(name, LABEL_MAX[column], ` · ${count}`),
        path: `${dir}/ (${plural(count, 'doc')})`,
        linksOut: 0,
        linkedFrom: 0,
        count,
        flagged: false,
        order: Math.min(group?.order ?? order, order),
      })
    } else {
      nodeOf.set(n.id, n.id)
      drafts.set(n.id, {
        id: n.id,
        kind: n.type,
        column,
        label: docLabel(n.path, LABEL_MAX[column]),
        path: n.path,
        linksOut: n.linksOut,
        linkedFrom: n.linkedFrom,
        count: 1,
        flagged: false,
        order,
      })
    }
  }

  const links: Omit<MdMapEdge, 'd'>[] = []
  const drawn = new Set<string>()
  net.edges.forEach((e, i) => {
    const from = nodeOf.get(e.from)
    const source = from === undefined ? undefined : drafts.get(from)
    if (from === undefined || !source) return
    const to = e.broken ? `missing:${e.to}` : nodeOf.get(e.to)
    if (e.broken && to !== undefined && !drafts.has(to)) {
      const column = Math.min(source.column + 1, LAST_COLUMN)
      drafts.set(to, {
        id: to,
        kind: 'missing',
        column,
        label: docLabel(e.to, LABEL_MAX[column]),
        path: `${e.to} (missing)`,
        linksOut: 0,
        linkedFrom: 0,
        count: 0,
        flagged: false,
        order: i,
      })
    }
    const target = to === undefined ? undefined : drafts.get(to)
    if (to === undefined || !target || to === from) return
    if (source.kind === 'folder') source.linksOut += 1
    if (target.kind === 'folder' || target.kind === 'missing') target.linkedFrom += 1
    const pair = from < to ? `${from}\0${to}` : `${to}\0${from}`
    if (drawn.has(pair)) return
    drawn.add(pair)
    links.push({ from, to, broken: e.broken === true })
  })

  const findingNodes = net.findings.map((f) => {
    if (f.type === 'broken-link') {
      const source = nodeOf.get(f.file)
      const marked = source === undefined ? undefined : drafts.get(source)
      if (marked) marked.flagged = true
      return [source, `missing:${f.to}`].filter((id): id is string => id !== undefined && drafts.has(id))
    }
    const id = `orphan:${f.where}`
    if (!drafts.has(id)) {
      drafts.set(id, {
        id,
        kind: 'orphan',
        column: LAST_COLUMN,
        label: fit(f.where, LABEL_MAX[LAST_COLUMN], ` · ${f.count}`),
        path: `${f.where} (${plural(f.count, 'doc')})`,
        linksOut: 0,
        linkedFrom: 0,
        count: f.count,
        flagged: false,
        order: Number.POSITIVE_INFINITY,
      })
    }
    return [id]
  })

  const columns: DraftNode[][] = COLUMN_X.map(() => [])
  for (const d of drafts.values()) columns[d.column].push(d)
  const fullest = Math.max(...columns.map((list) => list.length))
  const height = opts.minRowGap === undefined ? MAP_HEIGHT : Math.max(MAP_HEIGHT, 2 * ROW_TOP + fullest * opts.minRowGap)
  const rowBottom = height - ROW_TOP
  const nodes: MdMapNode[] = []
  const at = new Map<string, MdMapNode>()
  columns.forEach((list, column) => {
    // Stable sort: ties (orphan groups) keep their findings order.
    list.sort((a, b) => (a.order === b.order ? 0 : a.order < b.order ? -1 : 1))
    const step = (rowBottom - ROW_TOP) / list.length
    list.forEach((d, row) => {
      const node: MdMapNode = {
        id: d.id,
        kind: d.kind,
        column,
        x: COLUMN_X[column],
        y: round1(ROW_TOP + (row + 0.5) * step),
        label: d.label,
        path: d.path,
        linksOut: d.linksOut,
        linkedFrom: d.linkedFrom,
        count: d.count,
        flagged: d.flagged,
      }
      nodes.push(node)
      at.set(node.id, node)
    })
  })

  const edges = links.flatMap((l) => {
    const a = at.get(l.from)
    const b = at.get(l.to)
    return a && b ? [{ ...l, d: edgePath(a, b) }] : []
  })
  return { nodes, edges, findingNodes, width: MAP_WIDTH, height }
}

interface NodeLook {
  r: number
  dot: string
  strokeWidth: number
  dash?: string
  label: string
  weight: string
}

const NODE_LOOK: Record<MdMapNodeKind, NodeLook> = {
  hub: { r: 9, dot: 'fill-fg stroke-fg', strokeWidth: 0, label: 'fill-fg', weight: 'font-bold' },
  owner: { r: 5.5, dot: 'fill-fg-dim stroke-fg-dim', strokeWidth: 0, label: 'fill-fg-dim', weight: 'font-medium' },
  doc: { r: 4, dot: 'fill-bg-hi stroke-fg-faint', strokeWidth: 1.3, label: 'fill-fg-faint', weight: 'font-normal' },
  folder: { r: 6.5, dot: 'fill-rule-inner stroke-fg-faint', strokeWidth: 1.3, label: 'fill-fg-faint', weight: 'font-normal' },
  missing: { r: 5, dot: 'fill-none stroke-accent', strokeWidth: 1.5, dash: '2.5 2', label: 'fill-accent', weight: 'font-medium' },
  orphan: { r: 5.5, dot: 'fill-bg-hi stroke-fg-faint', strokeWidth: 1.3, dash: '2.5 2', label: 'fill-fg-faint', weight: 'font-normal' },
}

const LEGEND: readonly { label: string; swatch: string }[] = [
  { label: 'Entry map', swatch: 'h-2.5 w-2.5 bg-fg' },
  { label: 'Owner doc', swatch: 'h-[9px] w-[9px] bg-fg-dim' },
  { label: 'Doc', swatch: 'h-[9px] w-[9px] border-[1.3px] border-fg-faint bg-bg-hi' },
  { label: 'Finding', swatch: 'h-[9px] w-[9px] border-2 border-accent' },
  { label: 'Missing', swatch: 'h-[9px] w-[9px] border-[1.5px] border-dashed border-accent' },
]

/** What a hovered finding lights on the map. */
export interface MapFocus {
  ids: readonly string[]
  caption: string
}

function neighbourhood(edges: readonly MdMapEdge[], id: string): Set<string> {
  const near = new Set([id])
  for (const e of edges) {
    if (e.from === id) near.add(e.to)
    else if (e.to === id) near.add(e.from)
  }
  return near
}

function edgeClass(broken: boolean, lit: boolean): string {
  if (broken) return 'fill-none stroke-accent'
  return lit ? 'fill-none stroke-fg-dim' : 'fill-none stroke-fg-faint'
}

export interface MdMapGraphProps {
  layout: MdLinkMapLayout
  /** The lit node ids (a hovered node's neighbourhood or a finding's nodes); null lights all. */
  focus: ReadonlySet<string> | null
  /** The hovered node, whose own edges alone light; null when nothing (or a finding) is hovered. */
  hoveredId: string | null
  /** The node drawn with an accent selection ring. */
  selectedId?: string | null
  /** A node's id on mouse enter, null on mouse leave. */
  onHover: (id: string | null) => void
  /** When given, nodes are buttons: click, Enter or Space call it. */
  onNodeClick?: (node: MdMapNode) => void
}

/** The map's edges and nodes, drawn into an enclosing `<svg>` sized to the layout. */
export function MdMapGraph({ layout, focus, hoveredId, selectedId = null, onHover, onNodeClick }: MdMapGraphProps) {
  const edgeOn = (e: MdMapEdge) => {
    if (!focus) return true
    if (hoveredId !== null) return e.from === hoveredId || e.to === hoveredId
    return focus.has(e.from) && focus.has(e.to)
  }
  return (
    <>
      {layout.edges.map((e) => {
        const on = edgeOn(e)
        const lit = focus !== null && on
        let opacity = 0.12
        if (on) opacity = e.broken || focus ? 1 : 0.6
        return (
          <path
            key={`${e.from} > ${e.to}`}
            data-testid="md-link-map-edge"
            data-from={e.from}
            data-to={e.to}
            data-broken={e.broken ? 'true' : undefined}
            data-lit={lit ? 'true' : undefined}
            d={e.d}
            className={edgeClass(e.broken, lit)}
            strokeWidth={e.broken ? 1.6 : 1.2}
            strokeDasharray={e.broken ? '5 4' : undefined}
            style={{ opacity }}
          />
        )
      })}
      {layout.nodes.map((n) => {
        const look = NODE_LOOK[n.kind]
        const hot = focus !== null && focus.has(n.id)
        let state = 'idle'
        if (focus) state = hot ? 'hot' : 'dim'
        const r = hot ? look.r + 1.5 : look.r
        const above = n.column <= 1
        const selected = selectedId !== null && selectedId === n.id
        const button = onNodeClick
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': n.path,
              onClick: () => onNodeClick(n),
              onKeyDown: (ev: KeyboardEvent<SVGGElement>) => {
                if (ev.key !== 'Enter' && ev.key !== ' ') return
                ev.preventDefault()
                onNodeClick(n)
              },
            }
          : {}
        return (
          <g
            key={n.id}
            data-testid="md-link-map-node"
            data-node-id={n.id}
            data-kind={n.kind}
            data-state={state}
            data-selected={selected ? 'true' : undefined}
            onMouseEnter={() => onHover(n.id)}
            onMouseLeave={() => onHover(null)}
            className={onNodeClick ? 'cursor-pointer transition-opacity duration-150' : 'transition-opacity duration-150'}
            style={{ opacity: state === 'dim' ? 0.25 : 1 }}
            {...button}
          >
            <circle cx={n.x} cy={n.y} r={14} className="fill-transparent" />
            {selected && (
              <circle
                data-testid="md-link-map-ring"
                cx={n.x}
                cy={n.y}
                r={r + 4}
                className="fill-none stroke-accent"
                strokeWidth={2}
              />
            )}
            <circle
              data-testid="md-link-map-dot"
              cx={n.x}
              cy={n.y}
              r={r}
              className={n.flagged ? 'fill-bg stroke-accent' : look.dot}
              strokeWidth={n.flagged ? 2 : look.strokeWidth}
              strokeDasharray={look.dash}
            />
            <text
              x={above ? n.x : round1(n.x + r + 6)}
              y={above ? round1(n.y - r - 6) : round1(n.y + 3.5)}
              textAnchor={above ? 'middle' : 'start'}
              strokeWidth={4}
              className={`stroke-bg-hi font-mono text-[10.5px] [paint-order:stroke] [stroke-linejoin:round] ${
                n.flagged ? 'fill-accent' : look.label
              } ${hot ? 'font-bold' : look.weight}`}
            >
              {n.label}
            </text>
            {n.kind === 'hub' && (
              <text
                x={n.x}
                y={round1(n.y + r + 15)}
                textAnchor="middle"
                strokeWidth={4}
                className="fill-fg-faint stroke-bg-hi font-mono text-[9.5px] [paint-order:stroke]"
              >
                entry map
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

/** The LINK MAP card: legend, SVG and hover caption. */
export function MdLinkMap({
  layout,
  focusFinding,
  onExplore,
}: {
  layout: MdLinkMapLayout
  focusFinding: MapFocus | null
  /** When given: an Expand button opens the explorer (null), a node click opens it on that node. */
  onExplore?: (id: string | null) => void
}) {
  const [hoverId, setHoverId] = useState<string | null>(null)
  // A hovered id a refreshed scan dropped is no hover at all.
  const hovered = hoverId === null ? undefined : layout.nodes.find((n) => n.id === hoverId)
  let focus: ReadonlySet<string> | null = null
  let caption = HINT
  if (hovered) {
    focus = neighbourhood(layout.edges, hovered.id)
    caption = `${hovered.path} · links out ${hovered.linksOut} · linked from ${hovered.linkedFrom}`
  } else if (focusFinding) {
    focus = new Set(focusFinding.ids)
    caption = focusFinding.caption
  }

  return (
    <section
      data-testid="md-link-map"
      aria-label="Link map"
      className="min-w-0 flex-[1_1_560px] overflow-hidden rounded-xl border border-rule-structural bg-bg-hi"
    >
      <div className="flex flex-wrap items-center gap-3.5 border-b border-rule-inner px-4 py-3">
        <span className="font-mono text-[10.5px] tracking-[.1em] text-fg-faint">LINK MAP</span>
        <span className="flex-1" />
        {LEGEND.map((l) => (
          <span key={l.label} data-testid="md-link-map-legend" className="flex items-center gap-1.5 text-[11.5px] text-fg-faint">
            <span className={`flex-none rounded-full ${l.swatch}`} />
            {l.label}
          </span>
        ))}
        {onExplore && (
          <button
            type="button"
            data-testid="md-link-map-expand"
            aria-label="Open the full-screen explorer"
            onClick={() => onExplore(null)}
            className="inline-flex h-[26px] flex-none items-center gap-1.5 rounded-md border border-rule-structural bg-bg-hi px-2.5 text-[11.5px] font-semibold text-fg-dim cursor-pointer hover:border-fg-faint hover:text-fg"
          >
            Expand
          </button>
        )}
      </div>
      <div className="px-3 pt-2.5 pb-0.5">
        <svg data-testid="md-link-map-svg" viewBox="0 0 760 392" role="img" aria-label="Markdown link map" className="block h-auto w-full">
          <MdMapGraph
            layout={layout}
            focus={focus}
            hoveredId={hovered ? hovered.id : null}
            onHover={setHoverId}
            onNodeClick={onExplore ? (n) => onExplore(n.id) : undefined}
          />
        </svg>
      </div>
      <div data-testid="md-link-map-caption" className="min-h-[30px] break-all px-4 pt-1.5 pb-3 font-mono text-[11px] text-fg-faint">
        {caption}
      </div>
    </section>
  )
}

/** The repo-relative path a finding's Open reveals: the linking doc, or the orphan group's folder. */
function findingTarget(f: MdNetworkFinding): string {
  return f.type === 'broken-link' ? f.file : f.where
}

function absolutePath(cwd: string, rel: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const tail = rel === '.' || rel === './' ? '' : rel.replace(/^\.\//, '').replace(/\/+$/, '')
  return tail === '' ? base : `${base}/${tail}`
}

function openFinding(cwd: string, f: MdNetworkFinding): void {
  const rel = findingTarget(f)
  const fail = (why: string) => toast.error(`Could not open ${rel}: ${why}`)
  window.api.shell.open({ as: 'revealPath', path: absolutePath(cwd, rel) }).then(
    (res) => {
      if (!res.ok) fail(res.error ?? 'unknown error')
    },
    (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
  )
}

/** The FINDINGS card: one row per finding; hovering a row reports its index. */
export function MdFindings({
  cwd,
  findings,
  hovered,
  onHover,
}: {
  cwd?: string | null
  findings: readonly MdNetworkFinding[]
  hovered: number | null
  onHover: (index: number | null) => void
}) {
  return (
    <section
      data-testid="md-findings"
      aria-label="Findings"
      className="min-w-0 flex-[1_1_300px] overflow-hidden rounded-xl border border-rule-structural bg-bg-hi"
    >
      <div className="flex justify-between px-4 py-3 font-mono text-[10.5px] text-fg-faint">
        <span className="tracking-[.1em]">FINDINGS</span>
        <span data-testid="md-findings-count">{findings.length}</span>
      </div>
      {findings.length === 0 && (
        <p data-testid="md-findings-empty" className="m-0 border-t border-bg-elev px-4 py-3 text-[12.5px] text-fg-faint">
          No broken links or orphan docs.
        </p>
      )}
      {findings.map((f, i) => (
        <div
          key={`${f.type} ${f.where}`}
          data-testid="md-finding"
          data-type={f.type}
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(null)}
          className={`flex flex-col gap-1.5 border-t border-bg-elev px-4 py-3 ${hovered === i ? 'bg-bg-elev' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span
              data-testid="md-finding-type"
              className={`rounded px-[7px] py-[3px] font-mono text-[10px] font-bold tracking-[.04em] ${
                f.type === 'broken-link' ? 'bg-accent text-bg-hi' : 'bg-rule-inner text-fg-dim'
              }`}
            >
              {f.type}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="md-finding-open"
              disabled={!cwd}
              onClick={() => {
                if (cwd) openFinding(cwd, f)
              }}
              className="text-[12px] font-semibold text-accent-dark cursor-pointer hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Open
            </button>
          </div>
          <span data-testid="md-finding-where" className="break-all font-mono text-[11.5px] text-fg">
            {f.where}
          </span>
          <span data-testid="md-finding-detail" className="text-[12.5px] leading-[1.45] text-fg-dim">
            {f.detail}
          </span>
        </div>
      ))}
    </section>
  )
}

/** Both cards side by side over one scan; a hovered finding lights its nodes on the map. */
export function MdNetworkCards({
  cwd,
  network,
  onExplore,
}: {
  cwd?: string | null
  network: MdNetwork
  onExplore?: (id: string | null) => void
}) {
  const layout = useMemo(() => layoutMdNetwork(network), [network])
  const [hoverFinding, setHoverFinding] = useState<number | null>(null)
  const finding = hoverFinding === null ? undefined : network.findings[hoverFinding]
  const focusFinding: MapFocus | null =
    finding && hoverFinding !== null
      ? { ids: layout.findingNodes[hoverFinding] ?? [], caption: `${finding.type} · ${finding.where}` }
      : null
  return (
    <div className="flex flex-none flex-wrap items-start gap-4">
      <MdLinkMap layout={layout} focusFinding={focusFinding} onExplore={onExplore} />
      <MdFindings cwd={cwd} findings={network.findings} hovered={hoverFinding} onHover={setHoverFinding} />
    </div>
  )
}
