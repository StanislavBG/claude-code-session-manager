import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { ActivityEvent, ActivityKind } from '../../../state/live'
import {
  ROBOT_EMIT_X, ROBOT_EMIT_Y,
  BOARD_X, BOARD_Y, BOARD_W, BOARD_H,
  DOCK_X, DOCK_Y, DOCK_W, DOCK_H,
  WB_X, WB_Y, WB_W, WB_H,
  STICKY_X, STICKY_Y,
  CONV_X, CONV_Y, CONV_W, CONV_H,
  FLOOR_Y,
  PAL,
} from './sceneConstants'
import { TOOL_RECIPES, FALLBACK_RECIPE, type ToolRecipe, type GagType } from './toolRecipes'

export interface FlyingObjectsProps {
  activityRing: ActivityEvent[]
  activitySeq: number
  lively: boolean
  onConveyorHit?: () => void
}

interface InFlight {
  id: number
  activityKind: ActivityKind
  recipe: ToolRecipe | null
  label: string
  startX: number
  startY: number
  endX: number
  endY: number
}

interface StickyNote {
  id: number
  label: string
  rotation: number
}

const MAX_IN_FLIGHT = 6
let objIdCounter = 0
let stickyIdCounter = 0

// Orbit keyframes (module-scope, computed once)
const ORBIT_STEPS = 25
const ORBIT_X = Array.from({ length: ORBIT_STEPS }, (_, i) => 20 * Math.cos((i / (ORBIT_STEPS - 1)) * Math.PI * 4))
const ORBIT_Y = Array.from({ length: ORBIT_STEPS }, (_, i) => 10 * Math.sin((i / (ORBIT_STEPS - 1)) * Math.PI * 4))
const ORBIT_TIMES = Array.from({ length: ORBIT_STEPS }, (_, i) => i / (ORBIT_STEPS - 1))

// ── Destination coordinates ──────────────────────────────────────────────────

function destCoords(recipe: ToolRecipe | null, kind: ActivityKind): { x: number; y: number } {
  switch (recipe?.destination) {
    case 'conveyor':    return { x: CONV_X + CONV_W / 2, y: CONV_Y + CONV_H / 2 }
    case 'bench':       return { x: STICKY_X + 20, y: STICKY_Y - 5 }
    case 'kanban':      return { x: BOARD_X + BOARD_W / 2, y: BOARD_Y + BOARD_H / 3 }
    case 'dock':        return { x: DOCK_X + DOCK_W / 2, y: DOCK_Y + DOCK_H / 2 }
    case 'whiteboard':  return { x: WB_X + WB_W / 2, y: WB_Y + WB_H / 2 }
    case 'sky':         return { x: 500, y: 60 }
    case 'floor':       return { x: 310, y: FLOOR_Y - 10 }
    default:
      switch (kind) {
        case 'todo-update':   return { x: BOARD_X + BOARD_W / 2, y: BOARD_Y + BOARD_H / 3 }
        case 'agent-spawn':   return { x: DOCK_X + DOCK_W / 2, y: DOCK_Y + DOCK_H / 2 }
        case 'plan-revision': return { x: WB_X + WB_W / 2, y: WB_Y + WB_H / 2 }
        case 'file-edit':     return { x: STICKY_X + 20, y: STICKY_Y - 5 }
        case 'usage-tick':    return { x: CONV_X + CONV_W / 2, y: CONV_Y }
        default:              return { x: CONV_X + CONV_W / 2, y: CONV_Y + CONV_H / 2 }
      }
  }
}

function recipeColor(recipe: ToolRecipe | null, kind: ActivityKind): string {
  if (!recipe) {
    switch (kind) {
      case 'todo-update':   return '#0d9488'
      case 'plan-revision': return '#7c3aed'
      case 'agent-spawn':   return '#22c55e'
      case 'usage-tick':    return '#f97316'
      case 'file-edit':     return '#3b82f6'
      default:              return PAL.accentAmber
    }
  }
  const g = recipe.glyph
  if (g === '🔧' || g === '📜' || g === '💥') return '#f59e0b'
  if (g === '📖' || g === '✏️' || g === '🔍' || g === '🔦') return '#60a5fa'
  if (g === '🛰️') return '#22d3ee'
  if (g === '🤖') return '#22c55e'
  if (g === '📋') return '#0d9488'
  if (g === '📝') return '#7c3aed'
  return '#9ca3af'
}

function kindSymbol(kind: ActivityKind): string {
  switch (kind) {
    case 'tool-use':      return '⚙'
    case 'file-edit':     return '✎'
    case 'todo-update':   return '✓'
    case 'plan-revision': return '≡'
    case 'agent-spawn':   return '◉'
    case 'usage-tick':    return '⚡'
    default:              return '•'
  }
}

function labelRotation(label: string): number {
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0
  return (hash % 17) - 8
}

// ── Gag durations ────────────────────────────────────────────────────────────

const GAG_DURATIONS: Record<GagType, number> = {
  spark: 450, flip: 560, scribble: 720, glow: 360, fan: 660,
  orbit: 1400, tick: 460, boot: 420, sparkle: 720, unfurl: 560, puff: 460, spin: 720,
}

// ── Gag sub-components (rendered at local origin 0,0) ────────────────────────

function SparkGag({ color }: { color: string }) {
  return (
    <>
      {[0, 60, 120, 180, 240, 300].map((deg, i) => {
        const rad = deg * Math.PI / 180
        return (
          <motion.circle key={i} cx={0} cy={0} r={2.5} fill={color}
            initial={{ x: 0, y: 0, opacity: 1 }}
            animate={{ x: Math.cos(rad) * 14, y: Math.sin(rad) * 14, opacity: 0 }}
            transition={{ duration: 0.42, delay: i * 0.025, ease: 'easeOut' }}
          />
        )
      })}
      <motion.circle cx={0} cy={0} fill={color}
        initial={{ r: 0 }} animate={{ r: [0, 6, 0] }} transition={{ duration: 0.22, ease: 'easeOut' }} />
    </>
  )
}

function FlipGag({ color }: { color: string }) {
  return (
    <motion.rect x={-8} y={-5} width={16} height={10} rx={1.5} fill={color}
      animate={{ scaleX: [1, 0.1, 1] }}
      transition={{ duration: 0.55, ease: 'easeInOut', times: [0, 0.5, 1] }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
  )
}

function ScribbleGag({ color }: { color: string }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.rect key={i} x={-8} y={-4 + i * 3.5} height={1.5} rx={0.5} fill={color}
          initial={{ width: 0, opacity: 0.95 }}
          animate={{ width: 10 + i * 3, opacity: 0 }}
          transition={{ duration: 0.4, delay: i * 0.14, ease: 'easeOut' }} />
      ))}
    </>
  )
}

function GlowGag({ color }: { color: string }) {
  return (
    <motion.circle cx={0} cy={0} fill="none" stroke={color} strokeWidth={2.5}
      initial={{ r: 5, opacity: 0.95 }} animate={{ r: 22, opacity: 0 }}
      transition={{ duration: 0.36, ease: 'easeOut' }} />
  )
}

function FanGag({ color }: { color: string }) {
  return (
    <motion.polygon points="0,0 72,-18 72,18" fill={color}
      initial={{ scaleX: 0, opacity: 0.7 }} animate={{ scaleX: 1, opacity: 0 }}
      transition={{ duration: 0.65, ease: 'easeOut' }}
      style={{ transformBox: 'fill-box', transformOrigin: '0% 50%' }} />
  )
}

function OrbitGag({ color }: { color: string }) {
  return (
    <>
      <motion.g
        animate={{ x: ORBIT_X, y: ORBIT_Y }}
        transition={{ duration: 1.35, ease: 'linear', times: ORBIT_TIMES }}
      >
        <rect x={-4} y={-2.5} width={8} height={5} rx={1} fill={color} />
        <rect x={-8} y={-1} width={16} height={2} rx={0.5} fill={color} opacity={0.5} />
      </motion.g>
      <motion.path d="M 0 0 L -100 220"
        stroke={color} strokeWidth={1} strokeDasharray="4 4" fill="none"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: [0, 0.45, 0] }}
        transition={{ duration: 1.35, ease: 'easeOut', delay: 0.2 }} />
    </>
  )
}

function TickGag({ color }: { color: string }) {
  return (
    <motion.path d="M -6 0 L -2 5 L 6 -5"
      stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round"
      initial={{ pathLength: 0, opacity: 1 }}
      animate={{ pathLength: 1, opacity: [1, 1, 0] }}
      transition={{ duration: 0.46, ease: 'easeOut', times: [0, 0.7, 1] }} />
  )
}

function BootGag({ color }: { color: string }) {
  return (
    <motion.circle cx={0} cy={0} r={7} fill={color}
      animate={{ opacity: [0, 1, 0, 1, 0.15] }}
      transition={{ duration: 0.42, times: [0, 0.2, 0.45, 0.65, 1] }} />
  )
}

function SparkleGag({ color }: { color: string }) {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const angle = (i / 6) * 2 * Math.PI
        return (
          <motion.circle key={i} cx={0} cy={0} r={2.5}
            fill={i % 2 === 0 ? color : '#fbbf24'}
            initial={{ x: 0, y: 0, opacity: 1 }}
            animate={{ x: Math.cos(angle) * 20, y: Math.sin(angle) * 20, opacity: 0 }}
            transition={{ duration: 0.6, delay: i * 0.04, ease: 'easeOut' }} />
        )
      })}
      <motion.rect x={-14} y={2} height={1.5} rx={0.75} fill={color}
        initial={{ width: 0 }}
        animate={{ width: 28, opacity: [0.9, 0.4, 0] }}
        transition={{ duration: 0.7, ease: 'easeOut' }} />
    </>
  )
}

function UnfurlGag({ color }: { color: string }) {
  return (
    <motion.rect x={-22} y={-3.5} width={44} height={7} rx={2} fill={color}
      initial={{ scaleX: 0, opacity: 0.85 }} animate={{ scaleX: 1, opacity: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
  )
}

function PuffGag({ color }: { color: string }) {
  return (
    <motion.circle cx={0} cy={0} fill={color}
      initial={{ r: 4, opacity: 0.75 }} animate={{ r: 22, opacity: 0 }}
      transition={{ duration: 0.44, ease: 'easeOut' }} />
  )
}

function SpinGag({ color }: { color: string }) {
  return (
    <motion.polygon points="0,-8 7,-4 7,4 0,8 -7,4 -7,-4" fill={color}
      animate={{ rotate: 360, opacity: [0.9, 0.9, 0] }}
      transition={{ duration: 0.72, ease: 'easeInOut', times: [0, 0.75, 1] }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
  )
}

function GagEffect({ gag, x, y, color, onDone }: {
  gag: GagType; x: number; y: number; color: string; onDone: () => void
}) {
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const t = window.setTimeout(() => onDoneRef.current(), GAG_DURATIONS[gag])
    return () => window.clearTimeout(t)
  }, [gag])

  let content: JSX.Element
  switch (gag) {
    case 'spark':    content = <SparkGag color={color} />; break
    case 'flip':     content = <FlipGag color={color} />; break
    case 'scribble': content = <ScribbleGag color={color} />; break
    case 'glow':     content = <GlowGag color={color} />; break
    case 'fan':      content = <FanGag color={color} />; break
    case 'orbit':    content = <OrbitGag color={color} />; break
    case 'tick':     content = <TickGag color={color} />; break
    case 'boot':     content = <BootGag color={color} />; break
    case 'sparkle':  content = <SparkleGag color={color} />; break
    case 'unfurl':   content = <UnfurlGag color={color} />; break
    case 'puff':     content = <PuffGag color={color} />; break
    case 'spin':     content = <SpinGag color={color} />; break
  }
  return <g transform={`translate(${x}, ${y})`}>{content}</g>
}

// ── FlyingObject: two-phase fly → gag ────────────────────────────────────────

function FlyingObject({
  obj, onDone, onConveyorHit,
}: {
  obj: InFlight; onDone: (id: number) => void; onConveyorHit?: () => void
}) {
  const [phase, setPhase] = useState<'fly' | 'gag'>('fly')
  const { recipe, activityKind, startX, startY, endX, endY } = obj
  const arcHeight = recipe?.arcHeight ?? 55
  const flyDuration = recipe ? (recipe.durationMs * 0.65) / 1000 : 0.9
  const arcTop = Math.min(startY, endY) - arcHeight
  const color = recipeColor(recipe, activityKind)

  const handleFlyDone = () => {
    if (recipe) {
      if (recipe.destination === 'conveyor') onConveyorHit?.()
      setPhase('gag')
    } else {
      onDone(obj.id)
    }
  }

  if (phase === 'fly') {
    return (
      <motion.g
        initial={{ x: startX, y: startY, opacity: 1, scale: 0.7 }}
        animate={{
          x: [startX, (startX + endX) / 2, endX],
          y: [startY, arcTop, endY],
          scale: [0.7, 1.3, 1.0],
          opacity: [1, 1, 1],
        }}
        transition={{ duration: flyDuration, ease: 'easeInOut', times: [0, 0.5, 1] }}
        onAnimationComplete={handleFlyDone}
        style={{ willChange: 'transform' }}
      >
        {recipe ? (
          <text textAnchor="middle" dominantBaseline="central" fontSize={15}
            style={{ userSelect: 'none', pointerEvents: 'none' }}>
            {recipe.glyph}
          </text>
        ) : (
          <>
            <circle r={10} fill={color} opacity={0.2} />
            <circle r={7} fill={color} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={7}
              fill="white" fontFamily="monospace" style={{ pointerEvents: 'none' }}>
              {kindSymbol(activityKind)}
            </text>
          </>
        )}
      </motion.g>
    )
  }

  // Gag phase: glyph fades while gag plays
  return (
    <>
      <motion.g
        style={{ x: endX, y: endY }}
        initial={{ opacity: 0.9, scale: 1 }}
        animate={{ opacity: 0, scale: 0.6 }}
        transition={{ duration: 0.35, delay: 0.1 }}
      >
        <text textAnchor="middle" dominantBaseline="central" fontSize={15}
          style={{ userSelect: 'none', pointerEvents: 'none' }}>
          {recipe!.glyph}
        </text>
      </motion.g>
      <GagEffect gag={recipe!.gag} x={endX} y={endY} color={color} onDone={() => onDone(obj.id)} />
    </>
  )
}

// ── StickyNote ────────────────────────────────────────────────────────────────

function StickyNoteEl({ note, stackIdx }: { note: StickyNote; stackIdx: number }) {
  const x = STICKY_X + stackIdx * 3
  const y = STICKY_Y - stackIdx * 2
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.5 }}
      transition={{ type: 'spring', stiffness: 200, damping: 18 }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 50%', willChange: 'transform' }}
    >
      <g transform={`translate(${x}, ${y}) rotate(${note.rotation})`}>
        <rect x={0} y={0} width={12} height={10} rx={1} fill={PAL.stickyFill} stroke={PAL.stickyBorder} strokeWidth="0.8" />
        <rect x={1.5} y={3} width={9} height={1} rx={0.5} fill={PAL.stickyBorder} opacity={0.5} />
        <rect x={1.5} y={5.5} width={7} height={1} rx={0.5} fill={PAL.stickyBorder} opacity={0.5} />
      </g>
    </motion.g>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function FlyingObjects({ activityRing, activitySeq, onConveyorHit }: FlyingObjectsProps) {
  const lastSeqRef = useRef(0)
  const [inFlight, setInFlight] = useState<InFlight[]>([])
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([])

  useEffect(() => {
    if (activitySeq <= lastSeqRef.current) return
    const newEvents = activityRing.filter((e) => e.id > lastSeqRef.current)
    lastSeqRef.current = activitySeq
    if (newEvents.length === 0) return

    const newObjects: InFlight[] = newEvents.map((ev) => {
      const recipe = ev.toolName ? (TOOL_RECIPES[ev.toolName] ?? FALLBACK_RECIPE) : null
      const { x, y } = destCoords(recipe, ev.kind)
      return {
        id: ++objIdCounter,
        activityKind: ev.kind,
        recipe,
        label: ev.label,
        startX: ROBOT_EMIT_X,
        startY: ROBOT_EMIT_Y,
        endX: x,
        endY: y,
      }
    })

    setInFlight((prev) => [...prev, ...newObjects].slice(-MAX_IN_FLIGHT))

    // Sticky notes for file-edit events
    const fileEdits = newEvents.filter((e) => e.kind === 'file-edit')
    if (fileEdits.length > 0) {
      const newStickies = fileEdits.map((ev) => ({
        id: ++stickyIdCounter,
        label: ev.label,
        rotation: labelRotation(ev.label),
      }))
      setStickyNotes((prev) => [...prev, ...newStickies].slice(-5))
      newStickies.forEach((s) => {
        window.setTimeout(() => setStickyNotes((prev) => prev.filter((n) => n.id !== s.id)), 15000)
      })
    }
  }, [activitySeq, activityRing])

  const handleDone = (id: number) => setInFlight((prev) => prev.filter((o) => o.id !== id))

  return (
    <g>
      <AnimatePresence>
        {stickyNotes.map((note, i) => <StickyNoteEl key={note.id} note={note} stackIdx={i} />)}
      </AnimatePresence>
      <AnimatePresence>
        {inFlight.map((obj) => (
          <FlyingObject key={obj.id} obj={obj} onDone={handleDone} onConveyorHit={onConveyorHit} />
        ))}
      </AnimatePresence>
    </g>
  )
}
