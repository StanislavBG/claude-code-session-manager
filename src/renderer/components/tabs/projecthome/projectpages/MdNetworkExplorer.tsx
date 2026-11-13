/**
 * The full-screen MD network explorer: Review MD network's link map in the shared Modal
 * (size `full`), over one `window.api.projectPages.mdNetwork` scan the caller already holds.
 * Header: the scan's counts, a search box, an optional Map | Docs toggle and Close. Body: the
 * canvas (MdMapGraph over `layoutMdNetwork(network, { expanded, minRowGap: 22 })`) with a
 * Zoom in / Zoom out / Fit toolbar, beside a 420px inspector column.
 *
 * Canvas: wheel zooms around the pointer (scale 0.4..4), dragging the background pans, Fit
 * scales the whole layout into the canvas. Clicking a folder node expands or folds it; any
 * other node selects its id. Search lights nodes whose path holds the text (any case) and
 * Enter selects the first match — a drawn node first, else a doc folded into a folder.
 *
 * The inspector shows `renderInspector(selectedId, select)` when given, else the selected
 * path with clickable Linked from / Links to lists from `network.edges`. An id the map does
 * not draw (a folded doc, a doc picked in Docs) still shows there. Docs view, the inspector
 * contents and the footer are the plug-in points for the doc preview, the Docs table and the
 * curation tray; Esc, focus trap and the z-layer are the Modal's.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Modal } from '../../../ui/Modal'
import { MdMapGraph, layoutMdNetwork, type MdMapEdge, type MdMapNode } from './MdLinkMap'
import type { MdNetwork } from '../../../../../preload/api'

export interface MdNetworkExplorerProps {
  network: MdNetwork
  cwd?: string | null
  initialPath?: string | null
  onClose: () => void
  /** Right panel for the selected node id (a doc path, or a folder:/missing:/orphan: id). */
  renderInspector?: (id: string | null, select: (id: string) => void) => ReactNode
  /** When given, a Map | Docs toggle shows and Docs renders this. */
  renderDocs?: (select: (id: string) => void) => ReactNode
  footer?: ReactNode
}

interface View {
  k: number
  x: number
  y: number
}

const MIN_K = 0.4
const MAX_K = 4
const STEP = 1.25
const MIN_ROW_GAP = 22
const FIT_PAD = 24
const HOME: View = { k: 1, x: 0, y: 0 }

const round3 = (n: number) => Math.round(n * 1000) / 1000
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The view after scaling by `factor` around the canvas point (px, py), which stays put. */
function zoomAround(v: View, px: number, py: number, factor: number): View {
  const k = round3(clampK(v.k * factor))
  if (k === v.k) return v
  const r = k / v.k
  return { k, x: round3(px - (px - v.x) * r), y: round3(py - (py - v.y) * r) }
}

function neighbourhood(edges: readonly MdMapEdge[], id: string): Set<string> {
  const near = new Set([id])
  for (const e of edges) {
    if (e.from === id) near.add(e.to)
    else if (e.to === id) near.add(e.from)
  }
  return near
}

interface LinkItem {
  id: string
  label: string
}

/** The selected id's incoming and outgoing links, from the scan's own edges. */
function linksOf(network: MdNetwork, id: string): { from: LinkItem[]; to: LinkItem[] } {
  const missing = id.startsWith('missing:') ? id.slice('missing:'.length) : null
  const from: LinkItem[] = []
  const to: LinkItem[] = []
  const seenFrom = new Set<string>()
  const seenTo = new Set<string>()
  for (const e of network.edges) {
    const into = missing !== null ? e.broken === true && e.to === missing : e.broken !== true && e.to === id
    if (into && !seenFrom.has(e.from)) {
      seenFrom.add(e.from)
      from.push({ id: e.from, label: e.from })
    }
    if (e.from === id) {
      const target = e.broken ? `missing:${e.to}` : e.to
      if (!seenTo.has(target)) {
        seenTo.add(target)
        to.push({ id: target, label: e.broken ? `${e.to} (missing)` : e.to })
      }
    }
  }
  return { from, to }
}

function LinkList({ testid, title, items, select }: { testid: string; title: string; items: LinkItem[]; select: (id: string) => void }) {
  return (
    <div data-testid={testid} className="flex flex-col gap-1">
      <span className="font-mono text-[10.5px] tracking-[.1em] text-fg-faint">
        {title} · {items.length}
      </span>
      {items.length === 0 && <span className="text-[12px] text-fg-faint">None.</span>}
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => select(it.id)}
          className="cursor-pointer break-all text-left font-mono text-[11.5px] text-accent-dark hover:underline"
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

function DefaultInspector({
  network,
  nodes,
  id,
  select,
}: {
  network: MdNetwork
  nodes: readonly MdMapNode[]
  id: string | null
  select: (id: string) => void
}) {
  if (id === null) {
    return <p className="m-0 text-[12.5px] text-fg-faint">Click a doc on the map to see what links to it and what it links to.</p>
  }
  const doc = network.nodes.find((n) => n.id === id)
  const drawn = nodes.find((n) => n.id === id)
  const path = doc?.path ?? drawn?.path ?? id
  const { from, to } = linksOf(network, id)
  return (
    <div className="flex flex-col gap-4">
      <span data-testid="md-explorer-selected-path" className="break-all font-mono text-[12.5px] font-semibold text-fg">
        {path}
      </span>
      <LinkList testid="md-explorer-linked-from" title="LINKED FROM" items={from} select={select} />
      <LinkList testid="md-explorer-links-to" title="LINKS TO" items={to} select={select} />
    </div>
  )
}

const toolButton =
  'h-7 min-w-7 cursor-pointer rounded border border-rule-structural bg-bg-hi px-2 text-[12px] text-fg-dim hover:text-fg'

export function MdNetworkExplorer({ network, initialPath = null, onClose, renderInspector, renderDocs, footer }: MdNetworkExplorerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(initialPath ?? null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'map' | 'docs'>('map')
  const [view, setView] = useState<View>(HOME)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ pointerId: number; sx: number; sy: number; vx: number; vy: number } | null>(null)

  const layout = useMemo(() => layoutMdNetwork(network, { expanded, minRowGap: MIN_ROW_GAP }), [network, expanded])
  const select = useCallback((id: string) => setSelectedId(id), [])
  const showMap = mode === 'map' || !renderDocs

  const needle = query.trim().toLowerCase()
  const matches = useMemo(
    () => (needle === '' ? [] : layout.nodes.filter((n) => n.path.toLowerCase().includes(needle)).map((n) => n.id)),
    [layout, needle],
  )
  const hovered = hoverId === null ? undefined : layout.nodes.find((n) => n.id === hoverId)
  let focus: ReadonlySet<string> | null = null
  if (hovered) focus = neighbourhood(layout.edges, hovered.id)
  else if (needle !== '') focus = new Set(matches)

  const fit = useCallback(() => {
    const el = canvasRef.current
    const w = el?.clientWidth ?? 0
    const h = el?.clientHeight ?? 0
    if (w <= 0 || h <= 0) {
      setView(HOME)
      return
    }
    const k = round3(clampK(Math.min((w - 2 * FIT_PAD) / layout.width, (h - 2 * FIT_PAD) / layout.height)))
    setView({ k, x: round3((w - layout.width * k) / 2), y: round3((h - layout.height * k) / 2) })
  }, [layout.width, layout.height])

  // Fit once when the map first shows (and again on returning from Docs).
  // Through a ref, so expanding a folder (which grows the layout) keeps the user's zoom.
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    if (showMap) fitRef.current()
  }, [showMap])

  // Wheel zoom: a native non-passive listener so preventDefault stops the page scrolling.
  useEffect(() => {
    const el = canvasRef.current
    if (!showMap || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.0015)
      setView((v) => zoomAround(v, e.clientX - rect.left, e.clientY - rect.top, factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [showMap])

  const zoomCentre = (factor: number) => {
    const el = canvasRef.current
    const w = el?.clientWidth ?? 0
    const h = el?.clientHeight ?? 0
    setView((v) => zoomAround(v, w / 2, h / 2, factor))
  }

  const onPointerDown = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
  }
  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const x = round3(d.vx + e.clientX - d.sx)
    const y = round3(d.vy + e.clientY - d.sy)
    setView((v) => ({ ...v, x, y }))
  }
  const onPointerUp = (e: PointerEvent<SVGRectElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const onNodeClick = (n: MdMapNode) => {
    if (n.kind === 'folder') {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(n.id)) next.delete(n.id)
        else next.add(n.id)
        return next
      })
      setHoverId(null)
      return
    }
    setSelectedId(n.id)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || needle === '') return
    e.preventDefault()
    const first = matches[0] ?? network.nodes.find((n) => n.path.toLowerCase().includes(needle))?.id
    if (first !== undefined) setSelectedId(first)
  }

  return (
    <Modal open onClose={onClose} title="MD network" size="full" fillHeight noPadding>
      <div data-testid="md-explorer" className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-rule-inner px-6 pb-3">
          <span data-testid="md-explorer-counts" className="font-mono text-[11.5px] text-fg-faint">
            {plural(network.docs, 'doc')} in the network · {plural(network.links, 'link')} · {plural(network.findings.length, 'finding')}
          </span>
          <span className="flex-1" />
          <input
            data-testid="md-explorer-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search paths"
            aria-label="Search paths"
            className="h-7 w-56 rounded border border-rule-structural bg-bg-hi px-2 text-[12px] text-fg outline-none focus:border-accent"
          />
          {renderDocs && (
            <div role="group" aria-label="View" className="flex overflow-hidden rounded border border-rule-structural">
              <button
                type="button"
                data-testid="md-explorer-view-map"
                aria-pressed={mode === 'map'}
                onClick={() => setMode('map')}
                className={`h-7 cursor-pointer px-3 text-[12px] ${mode === 'map' ? 'bg-bg-elev font-semibold text-fg' : 'bg-bg-hi text-fg-dim'}`}
              >
                Map
              </button>
              <button
                type="button"
                data-testid="md-explorer-view-docs"
                aria-pressed={mode === 'docs'}
                onClick={() => setMode('docs')}
                className={`h-7 cursor-pointer px-3 text-[12px] ${mode === 'docs' ? 'bg-bg-elev font-semibold text-fg' : 'bg-bg-hi text-fg-dim'}`}
              >
                Docs
              </button>
            </div>
          )}
          <button type="button" data-testid="md-explorer-close" onClick={onClose} className={toolButton}>
            Close
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_420px]">
          {showMap ? (
            <div ref={canvasRef} data-testid="md-explorer-canvas" className="relative min-h-0 min-w-0 overflow-hidden bg-bg-hi">
              <div className="absolute left-3 top-3 flex gap-1.5">
                <button type="button" data-testid="md-explorer-zoom-in" aria-label="Zoom in" onClick={() => zoomCentre(STEP)} className={toolButton}>
                  +
                </button>
                <button type="button" data-testid="md-explorer-zoom-out" aria-label="Zoom out" onClick={() => zoomCentre(1 / STEP)} className={toolButton}>
                  −
                </button>
                <button type="button" data-testid="md-explorer-fit" onClick={fit} className={toolButton}>
                  Fit
                </button>
              </div>
              <svg role="img" aria-label="Markdown link map" className="block h-full w-full">
                <rect
                  data-testid="md-explorer-pan"
                  x={0}
                  y={0}
                  width="100%"
                  height="100%"
                  className="cursor-grab fill-transparent active:cursor-grabbing"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                />
                <g data-testid="md-explorer-viewport" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                  <MdMapGraph
                    layout={layout}
                    focus={focus}
                    hoveredId={hovered ? hovered.id : null}
                    selectedId={selectedId}
                    onHover={setHoverId}
                    onNodeClick={onNodeClick}
                  />
                </g>
              </svg>
            </div>
          ) : (
            <div data-testid="md-explorer-docs" className="min-h-0 min-w-0 overflow-auto">
              {renderDocs(select)}
            </div>
          )}
          <aside data-testid="md-explorer-inspector" className="min-h-0 overflow-auto border-l border-rule-inner px-5 py-4">
            {renderInspector ? (
              renderInspector(selectedId, select)
            ) : (
              <DefaultInspector network={network} nodes={layout.nodes} id={selectedId} select={select} />
            )}
          </aside>
        </div>
        {footer && <div className="flex-none border-t border-rule-inner">{footer}</div>}
      </div>
    </Modal>
  )
}
