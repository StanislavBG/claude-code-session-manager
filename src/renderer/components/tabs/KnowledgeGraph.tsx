import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { Panel } from '../ui/Panel'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../../state/toast'
import type { KgState, KgNode, KgProject } from '../../../preload/api'

/**
 * KnowledgeGraph — distilled intelligence over your raw prompt LOG
 * (~/.claude/knowledge-log/prompts.jsonl), NOT curated facts (that's Memory).
 *
 * SEGREGATED PER PROJECT: pick a project from the toolbar selector and the
 * graph, Q&A, and status all scope to that project's `cwd`. "Process now"
 * ingests new log lines across ALL projects in one pass (single watermark).
 *
 * Three panes: a force-directed graph of entities the backend extracted from
 * your prompts (node size = how often you mention it, color = type), an
 * interactive Q&A box that answers from the graph + your real words via
 * `claude -p`, and an ingest status strip with a "Process now" trigger.
 */

const TYPE_COLOR: Record<string, string> = {
  project: '#60a5fa',  // blue
  feature: '#34d399',  // emerald
  tool: '#fbbf24',     // amber
  tech: '#a78bfa',     // violet
  concept: '#f472b6',  // pink
  goal: '#f87171',     // red
  person: '#22d3ee',   // cyan
}
const typeColor = (t: string) => TYPE_COLOR[t] ?? '#9ca3af'

function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ w: 600, h: 400 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  return { ref, ...size }
}

export function KnowledgeGraph() {
  const [state, setState] = useState<KgState | null>(null)
  const [projects, setProjects] = useState<KgProject[]>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [ingesting, setIngesting] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [selected, setSelected] = useState<KgNode | null>(null)

  // Q&A
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<{ text: string; cited: { ts: string; prompt: string }[] } | null>(null)

  // Load the graph for a specific project (or the most-active one when cwd is null).
  const reload = useCallback(async (forCwd?: string | null) => {
    try { setState(await window.api.kg.get(forCwd ?? undefined)) }
    catch (e) { toast.error(`Knowledge graph load failed: ${(e as Error).message}`) }
  }, [])

  // Refresh the project list; on first load, default-select the most-active one.
  const reloadProjects = useCallback(async () => {
    try {
      const list = await window.api.kg.projects()
      setProjects(list)
      setCwd((prev) => prev ?? (list[0]?.cwd ?? null))
    } catch (e) { toast.error(`Projects load failed: ${(e as Error).message}`) }
  }, [])

  // Initial: list projects, then load the default project's graph.
  useEffect(() => { (async () => { await reloadProjects() })() }, [reloadProjects])
  useEffect(() => { reload(cwd) }, [cwd, reload])

  useEffect(() => {
    const off = window.api.kg.onIngestProgress((ev) => {
      setIngesting(ev.ingesting)
      if (ev.phase === 'extract') setProgress(`distilling batch ${ev.batch}/${ev.totalBatches}…`)
      else if (ev.phase === 'done') { setProgress(null); reload(cwd); reloadProjects() }
      else if (ev.phase === 'error') { setProgress(null); toast.error(`Ingest failed: ${ev.error ?? 'unknown'}`) }
      else setProgress('reading prompt log…')
    })
    return off
  }, [reload, reloadProjects, cwd])

  const runIngest = useCallback(async () => {
    setIngesting(true)
    const r = await window.api.kg.ingest()
    if (!r.ok) { toast.error(`Ingest failed: ${r.error ?? 'unknown'}`); setIngesting(false); return }
    if (r.added === 0) toast.info(r.note === 'no log yet' ? 'No prompts logged yet — the hook fills this as you work.' : 'Graphs already up to date.')
    else toast.info(`Distilled ${r.added} prompt${r.added === 1 ? '' : 's'} across ${r.projects ?? 1} project${(r.projects ?? 1) === 1 ? '' : 's'}.${r.stopped ? ' Stopped early (rate-limited) — run again to continue.' : ''}`)
    reload(cwd); reloadProjects()
  }, [reload, reloadProjects, cwd])

  const askQuestion = useCallback(async () => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAnswer(null)
    const r = await window.api.kg.ask(q, cwd ?? undefined)
    setAsking(false)
    if (!r.ok) { toast.error(`Q&A failed: ${r.error ?? 'unknown'}`); return }
    setAnswer({ text: r.answer ?? '', cited: r.cited ?? [] })
  }, [question, asking, cwd])

  const graphData = useMemo(() => {
    if (!state) return { nodes: [], links: [] }
    const ids = new Set(state.nodes.map((n) => n.id))
    return {
      nodes: state.nodes.map((n) => ({ ...n, val: Math.max(1, n.count) })),
      links: state.edges
        .filter((e) => ids.has(e.src) && ids.has(e.dst))
        .map((e) => ({ source: e.src, target: e.dst, relation: e.relation, weight: e.weight })),
    }
  }, [state])

  const { ref: graphRef, w, h } = useSize<HTMLDivElement>()
  const status = state?.status

  return (
    <Panel
      toolbar={
        <>
          {projects.length > 0 && (
            <select
              value={cwd ?? ''}
              onChange={(e) => { setSelected(null); setAnswer(null); setCwd(e.target.value) }}
              className="text-xs bg-bg border border-line rounded px-1.5 py-0.5 text-fg outline-none focus:border-fg-faint max-w-[220px]"
              title={cwd ?? undefined}
            >
              {projects.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.label} ({p.total}{p.pending > 0 ? ` · ${p.pending} new` : ''})
                </option>
              ))}
            </select>
          )}
          <span className="text-fg-faint">{state ? `${state.nodes.length} entities · ${state.edges.length} relations` : 'loading…'}</span>
          <div className="flex-1" />
          {status && status.pending > 0 && (
            <span className="text-amber-600 text-xs">{status.pending} new prompt{status.pending === 1 ? '' : 's'} to process</span>
          )}
          {progress && <span className="text-fg-faint text-xs">{progress}</span>}
          <button
            onClick={runIngest}
            disabled={ingesting}
            className="text-fg-dim hover:text-fg text-xs border border-line rounded px-2 py-0.5 disabled:opacity-40"
            title="Distill new prompt-log lines into the graph"
          >
            {ingesting ? 'Processing…' : 'Process now'}
          </button>
        </>
      }
    >
      <div className="h-full flex min-h-0">
        {/* Graph */}
        <div ref={graphRef} className="flex-1 min-w-0 relative bg-bg">
          {state && state.nodes.length > 0 ? (
            <ForceGraph2D
              width={w}
              height={h}
              graphData={graphData}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={4}
              nodeVal={(n: any) => n.val}
              nodeLabel={(n: any) => `${n.name} · ${n.type} · ${n.count}×`}
              nodeColor={(n: any) => typeColor(n.type)}
              linkColor={() => 'rgba(148,163,184,0.25)'}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(n: any) => setSelected(n as KgNode)}
              nodeCanvasObjectMode={() => 'after'}
              nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
                if (scale < 1.2) return
                ctx.font = `${11 / scale}px ui-sans-serif`
                ctx.fillStyle = 'rgba(226,232,240,0.85)'
                ctx.textAlign = 'center'
                ctx.fillText(n.name, n.x, n.y + 9)
              }}
            />
          ) : (
            <div className="h-full grid place-items-center p-8">
              <EmptyState
                title={status && status.totalPrompts === 0 ? 'No prompts logged yet' : 'Graph not built yet'}
                hint={
                  status && status.totalPrompts === 0
                    ? 'The UserPromptSubmit hook logs your messages as you work. Come back after a few prompts.'
                    : `${status?.totalPrompts ?? 0} prompts waiting — click "Process now" to distill them into a graph.`
                }
              />
            </div>
          )}
          {/* legend */}
          {state && state.nodes.length > 0 && (
            <div className="absolute bottom-2 left-2 flex flex-wrap gap-2 text-[10px] bg-bg-elev/80 rounded px-2 py-1 border border-line">
              {Object.entries(TYPE_COLOR).map(([t, c]) => (
                <span key={t} className="flex items-center gap-1 text-fg-faint">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: c }} />{t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right rail: Q&A + selected entity */}
        <div className="w-[340px] shrink-0 border-l border-line flex flex-col min-h-0 bg-bg-elev">
          <div className="p-3 border-b border-line">
            <div className="text-xs uppercase tracking-wider text-fg-faint mb-2">Ask your history</div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askQuestion() }}
              placeholder="e.g. What have I been trying to build? Summarize my intent threads."
              rows={3}
              className="w-full text-xs bg-bg border border-line rounded p-2 text-fg outline-none focus:border-fg-faint resize-none"
            />
            <button
              onClick={askQuestion}
              disabled={asking || !question.trim()}
              className="mt-2 w-full text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded py-1"
            >
              {asking ? 'Thinking…' : 'Ask (⌘↵)'}
            </button>
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-3">
            {answer && (
              <div>
                <div className="text-xs text-fg whitespace-pre-wrap leading-relaxed">{answer.text}</div>
                {answer.cited.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[10px] uppercase tracking-wider text-fg-faint cursor-pointer">
                      {answer.cited.length} prompt{answer.cited.length === 1 ? '' : 's'} cited
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {answer.cited.map((c, i) => (
                        <li key={i} className="text-[11px] text-fg-dim border-l-2 border-line pl-2">
                          <span className="text-fg-faint">{new Date(c.ts).toLocaleString()}</span>
                          <div className="line-clamp-3">{c.prompt}</div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {selected && (
              <div className="border-t border-line pt-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: typeColor(selected.type) }} />
                  <span className="text-sm text-fg">{selected.name}</span>
                  <span className="text-[10px] text-fg-faint">{selected.type} · {selected.count}×</span>
                </div>
                {selected.description && <div className="mt-1 text-xs text-fg-dim">{selected.description}</div>}
                <div className="mt-1 text-[10px] text-fg-faint">
                  {selected.firstTs && `first ${new Date(selected.firstTs).toLocaleDateString()}`}
                  {selected.lastTs && ` · last ${new Date(selected.lastTs).toLocaleDateString()}`}
                </div>
              </div>
            )}

            {!answer && !selected && (
              <div className="text-[11px] text-fg-faint">
                Click a node to inspect it, or ask a question. Answers are grounded in your own prompts via <code className="font-mono">claude -p</code>.
              </div>
            )}
          </div>

          {status && (
            <div className="p-2 border-t border-line text-[10px] text-fg-faint">
              {status.promptCount} processed{status.lastIngest ? ` · last ${new Date(status.lastIngest).toLocaleString()}` : ''}
            </div>
          )}
        </div>
      </div>
    </Panel>
  )
}
