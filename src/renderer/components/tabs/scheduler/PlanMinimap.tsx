import { useMemo, useRef } from 'react'
import type { Stage } from '../../../lib/schedulerStages'
import { InfoDot } from './sched-primitives'

/**
 * Dot geometry (px): 4px square on a 6px pitch, 4 rows → 22px of dots. PAD_X/PAD_Y is the inset that
 * leaves room for the brush's padding ring, so the whole strip is 26px inside the 28px band.
 */
const PITCH = 6
const DOT = 4
const ROWS = 4
const STAGE_GAP = 12
const PAD_X = 5
const PAD_Y = 2
/** Brush overhang beyond the cluster edges (< STAGE_GAP/2 so it never touches a neighbouring cluster). */
const BRUSH_OVERHANG = 4

type Tone = 'done' | 'running' | 'attention' | 'failed' | 'pending'
// Literal class names only (Tailwind JIT). Same palette as the stage columns' dots.
const TONE_CLASS: Record<Tone, string> = {
  done: 'bg-sage',
  running: 'bg-accent',
  attention: 'bg-butter',
  failed: 'bg-red-600',
  pending: 'bg-fg-faint/50',
}

interface MinimapDot { x: number; y: number; tone: Tone; title: string }
interface MinimapLayout {
  dots: MinimapDot[]
  /** Left edge / width of each stage's cluster, index = stage.n - 1. */
  stageX: number[]
  stageW: number[]
  width: number
}

function toneOf(status: string): Tone {
  if (status === 'completed' || status === 'skipped') return 'done'
  if (status === 'running' || status === 'investigating') return 'running'
  if (status === 'failed') return 'failed'
  if (status === 'needs_review' || status === 'quarantined') return 'attention'
  return 'pending'
}

/** One pass over every PRD, O(V). Computed once per snapshot (memoized by the caller's `stages`). */
function layoutMinimap(stages: Stage[]): MinimapLayout {
  const dots: MinimapDot[] = []
  const stageX: number[] = []
  const stageW: number[] = []
  let x = PAD_X
  for (const s of stages) {
    const cols = Math.max(1, Math.ceil(s.rows.length / ROWS))
    stageX.push(x)
    stageW.push(cols * PITCH)
    s.rows.forEach((r, i) => {
      dots.push({
        x: x + Math.floor(i / ROWS) * PITCH,
        y: PAD_Y + (i % ROWS) * PITCH,
        tone: toneOf(r.status),
        title: `${r.prdNumber ? `#${r.prdNumber}` : r.slug} ${r.title} — ${r.status}`,
      })
    })
    x += cols * PITCH + STAGE_GAP
  }
  return { dots, stageX, stageW, width: Math.max(0, x - STAGE_GAP) + PAD_X }
}

/** Lowest 0-based stage index whose rows include a status matching `pred`, or -1. */
export function firstStageWith(stages: Stage[], pred: (status: string) => boolean): number {
  return stages.findIndex((s) => s.rows.some((r) => pred(r.status)))
}
export const isRunningStatus = (s: string) => s === 'running' || s === 'investigating'
export const isBlockerStatus = (s: string) => s === 'failed' || s === 'needs_review' || s === 'quarantined'

interface PlanMinimapProps {
  stages: Stage[]
  /** 0-based first stage in the stage-column viewport, and how many fit. */
  first: number
  perView: number
  /** Scroll the stage strip so 0-based stage `i` is leftmost. Local scroll only. */
  onSeek: (i: number) => void
}

/**
 * WHOLE GRAPH band: every PRD as a 4px dot in stage-grouped clusters, one rust brush marking the
 * visible stage range. Dots are plain spans inside ONE component — no per-PRD component instance.
 */
export function PlanMinimap({ stages, first, perView, onSeek }: PlanMinimapProps) {
  const layout = useMemo(() => layoutMinimap(stages), [stages])
  const hasRunning = useMemo(() => firstStageWith(stages, isRunningStatus) >= 0, [stages])
  const hasBlocker = useMemo(() => firstStageWith(stages, isBlockerStatus) >= 0, [stages])
  const dragging = useRef(false)
  const n = stages.length

  const last = Math.min(n - 1, first + perView - 1)
  const brushL = layout.stageX[Math.min(first, n - 1)] ?? 0
  const brushR = (layout.stageX[last] ?? 0) + (layout.stageW[last] ?? 0)

  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    let idx = 0
    for (let i = 0; i < n; i++) if (layout.stageX[i] <= x) idx = i // O(stages) per pointer event
    onSeek(Math.max(0, Math.min(n - 1, idx - Math.floor(perView / 2))))
  }

  const seg = 'px-2 h-[20px] text-[11.5px] disabled:opacity-40 disabled:cursor-not-allowed'
  return (
    <div data-testid="plan-minimap" className="h-[28px] flex items-center gap-3 px-3 border-t border-rule-inner">
      <span className="shrink-0 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">
        Whole graph
        <InfoDot title="Every PRD in this plan as one dot, grouped by stage. The rust box is the range of stages shown below — drag it to scroll." />
      </span>
      <div
        data-testid="plan-minimap-dots"
        role="presentation"
        className="relative shrink min-w-0 overflow-hidden cursor-ew-resize touch-none"
        style={{ width: layout.width, height: ROWS * PITCH - (PITCH - DOT) + 2 * PAD_Y }}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekAt(e) }}
        onPointerMove={(e) => { if (dragging.current) seekAt(e) }}
        onPointerUp={() => { dragging.current = false }}
        onPointerCancel={() => { dragging.current = false }}
      >
        {layout.dots.map((d, i) => (
          <span
            key={i}
            title={d.title}
            data-tone={d.tone}
            className={`absolute rounded-[1px] ${TONE_CLASS[d.tone]}`}
            style={{ left: d.x, top: d.y, width: DOT, height: DOT }}
          />
        ))}
        <span
          data-testid="plan-minimap-brush"
          aria-hidden="true"
          className="absolute top-0 bottom-0 border border-accent bg-accent/10 rounded-[2px] pointer-events-none"
          style={{ left: brushL - BRUSH_OVERHANG, width: brushR - brushL + 2 * BRUSH_OVERHANG }}
        />
      </div>
      <span className="ml-auto shrink-0 font-mono text-[11.5px] text-fg-faint" data-testid="plan-minimap-range">
        stages {Math.min(first + 1, n)}–{last + 1} of {n}
      </span>
      <span className="shrink-0 inline-flex border border-line rounded overflow-hidden" role="group" aria-label="Jump the stage window">
        <button
          type="button"
          data-testid="minimap-running"
          disabled={!hasRunning}
          title={hasRunning ? 'Scroll to the lowest stage with a running PRD' : 'No stage has a running PRD'}
          onClick={() => onSeek(firstStageWith(stages, isRunningStatus))}
          className={`${seg} text-fg-dim hover:text-fg`}
        >
          Running
        </button>
        <button
          type="button"
          data-testid="minimap-blockers"
          disabled={!hasBlocker}
          title={hasBlocker ? 'Scroll to the lowest stage with a failed / needs-review / quarantined PRD' : 'No stage has a failed, needs-review or quarantined PRD'}
          onClick={() => onSeek(firstStageWith(stages, isBlockerStatus))}
          className={`${seg} text-fg-dim hover:text-fg border-l border-line`}
        >
          Blockers
        </button>
      </span>
    </div>
  )
}
