import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import {
  BENCH_L, BENCH_R, BENCH_FRONT_Y, BENCH_BACK_Y, BENCH_BOTTOM_Y, BENCH_LEG_Y,
  RACK_Y, RACK_L, RACK_R, RACK_H,
  CONV_X, CONV_Y, CONV_W, CONV_H,
  KETTLE_X, KETTLE_Y,
  PAL,
} from './sceneConstants'

export interface CrateSpawn {
  /** Monotonic id from AgentView. */
  id: number
  /** Single ASCII glyph (no emoji) — see CRATE_GLYPH_FOR_TOOL in AgentView. */
  glyph: string
}

interface WorkbenchProps {
  steamTriggered: boolean
  /** Increment to trigger one conveyor scroll tile (each unique value = one scroll) */
  conveyorScrollCount: number
  /** Latest crate to spawn at the right roller, if any. Id must be monotonic. */
  crateSpawn?: CrateSpawn | null
}

const MAX_CRATES = 5
const CRATE_TRAVEL_MS = 3000

const BENCH_W = BENCH_R - BENCH_L

const GRAIN_LINES = Array.from({ length: 8 }, (_, i) => ({
  x1: BENCH_L + 6 + i * (BENCH_W / 9),
  y1: BENCH_BACK_Y + 4,
  x2: BENCH_L + 12 + i * (BENCH_W / 9),
  y2: BENCH_BOTTOM_Y - 4,
}))

const HOOKS = [
  { x: RACK_L + 60 },
  { x: RACK_L + 110 },
  { x: RACK_L + 170 },
  { x: RACK_L + 225 },
]

// ── Steam puff ───────────────────────────────────────────────────────────────

function SteamPuff({ offsetX }: { offsetX: number }) {
  const sx = KETTLE_X - 12 + offsetX
  const sy = KETTLE_Y - 18
  const path = `M ${sx} ${sy} C ${sx - 4} ${sy - 10}, ${sx + 6} ${sy - 18}, ${sx + 2} ${sy - 28} C ${sx - 4} ${sy - 38}, ${sx + 6} ${sy - 46}, ${sx} ${sy - 56}`
  return (
    <motion.path
      d={path}
      stroke={PAL.steam}
      strokeWidth="2.5"
      fill="none"
      strokeLinecap="round"
      initial={{ opacity: 0, pathLength: 0, y: 0 }}
      animate={{ opacity: [0, 0.6, 0], pathLength: [0, 1, 1], y: -8 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.5, ease: 'easeOut' }}
    />
  )
}

// ── Tool silhouettes ─────────────────────────────────────────────────────────

function ToolSilhouettes() {
  return (
    <g opacity={0.7}>
      <g transform={`translate(${HOOKS[0].x}, ${RACK_Y + RACK_H + 4})`}>
        <rect x="-2" y="0" width="4" height="20" rx="1.5" fill={PAL.toolHook} />
        <ellipse cx="0" cy="2" rx="5" ry="3.5" fill="none" stroke={PAL.toolHook} strokeWidth="1.5" />
        <ellipse cx="0" cy="20" rx="4" ry="3" fill="none" stroke={PAL.toolHook} strokeWidth="1.5" />
      </g>
      <g transform={`translate(${HOOKS[1].x}, ${RACK_Y + RACK_H + 4})`}>
        <circle cx="0" cy="6" r="5" fill="none" stroke={PAL.toolHook} strokeWidth="1.5" />
        <line x1="3.5" y1="9.5" x2="7" y2="18" stroke={PAL.toolHook} strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <g transform={`translate(${HOOKS[2].x}, ${RACK_Y + RACK_H + 3})`}>
        <rect x="-2" y="0" width="4" height="16" rx="1" fill={PAL.toolHook} />
        <polygon points="-2,16 2,16 0,22" fill={PAL.toolHook} />
      </g>
      <g transform={`translate(${HOOKS[3].x}, ${RACK_Y + RACK_H + 5})`}>
        <path d="M -6 0 A 6 6 0 0 1 6 0" fill="none" stroke={PAL.toolHook} strokeWidth="1.5" />
        <line x1="0" y1="0" x2="0" y2="14" stroke={PAL.toolHook} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="0" cy="1" r="1.5" fill={PAL.toolHook} />
      </g>
    </g>
  )
}

// ── Conveyor belt — scrolls one tile on each hit ─────────────────────────────

function ConveyorBelt({ scrollCount }: { scrollCount: number }) {
  const [triggerKey, setTriggerKey] = useState(0)
  const prevCountRef = useRef(0)
  const segW = CONV_W / 5

  useEffect(() => {
    if (scrollCount <= prevCountRef.current) return
    prevCountRef.current = scrollCount
    setTriggerKey((k) => k + 1)
  }, [scrollCount])

  return (
    <g>
      <rect x={CONV_X} y={CONV_Y} width={CONV_W} height={CONV_H} rx="3" fill={PAL.conveyor} />

      {/* Clip to belt area so segments don't bleed outside rollers */}
      <clipPath id="conv-clip">
        <rect x={CONV_X + 3} y={CONV_Y} width={CONV_W - 6} height={CONV_H} />
      </clipPath>
      <g clipPath="url(#conv-clip)">
        {/* key remount → restart scroll animation each hit */}
        <motion.g
          key={triggerKey}
          initial={{ x: 0 }}
          animate={{ x: triggerKey > 0 ? -segW : 0 }}
          transition={{ duration: 0.25, ease: 'linear' }}
        >
          {/* 7 segments: one extra on right fills gap after scroll */}
          {Array.from({ length: 7 }).map((_, i) => (
            <rect
              key={i}
              x={CONV_X + (i - 1) * segW + 2}
              y={CONV_Y + 2}
              width={segW - 4}
              height={CONV_H - 4}
              rx="1.5"
              fill="#374151"
              opacity={0.6}
            />
          ))}
        </motion.g>
      </g>

      {/* Roller end caps (rendered on top of clip group) */}
      <ellipse cx={CONV_X}          cy={CONV_Y + CONV_H / 2} rx="3" ry={CONV_H / 2} fill="#374151" />
      <ellipse cx={CONV_X + CONV_W} cy={CONV_Y + CONV_H / 2} rx="3" ry={CONV_H / 2} fill="#374151" />
    </g>
  )
}

// ── Conveyor crates ──────────────────────────────────────────────────────────

interface ActiveCrate {
  id: number
  glyph: string
  bornAt: number
}

// Crate dimensions, sitting just above the belt.
const CRATE_W = 14
const CRATE_H = 10
const CRATE_TOP_Y = CONV_Y - CRATE_H - 1
const CRATE_START_X = CONV_X + CONV_W - CRATE_W / 2 - 2
const CRATE_END_X = CONV_X - CRATE_W / 2 - 2

function CrateGlyph({ crate, onDone }: {
  crate: ActiveCrate
  onDone: (id: number) => void
}) {
  return (
    <motion.g
      initial={{ x: CRATE_START_X, y: CRATE_TOP_Y, opacity: 0 }}
      animate={{
        x: [CRATE_START_X, CRATE_END_X, CRATE_END_X - 8],
        y: [CRATE_TOP_Y, CRATE_TOP_Y, CRATE_TOP_Y + 18],
        opacity: [0, 1, 1, 0],
      }}
      transition={{
        duration: (CRATE_TRAVEL_MS + 400) / 1000,
        ease: 'linear',
        times: [0, 0.05, 0.92, 1],
      }}
      onAnimationComplete={() => onDone(crate.id)}
    >
      <rect x={0} y={0} width={CRATE_W} height={CRATE_H} rx={1.5}
        fill="#7a5c1e" stroke="#3d2d0d" strokeWidth={0.8} />
      {/* Crate plank line */}
      <line x1={CRATE_W / 2} y1={0} x2={CRATE_W / 2} y2={CRATE_H}
        stroke="#3d2d0d" strokeWidth={0.5} opacity={0.5} />
      <text x={CRATE_W / 2} y={CRATE_H / 2 + 2.5}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily="monospace" fontSize={7} fill="#fde68a">
        {crate.glyph}
      </text>
    </motion.g>
  )
}

function CrateStatic({ crate, onDone }: {
  crate: ActiveCrate
  onDone: (id: number) => void
}) {
  // Reduced-motion: pick a deterministic mid-belt slot by id, dwell for the
  // same lifetime so the FIFO cap still rotates.
  const slot = crate.id % 4
  const segW = CONV_W / 5
  const x = CONV_X + segW * (1 + slot) - CRATE_W / 2
  useEffect(() => {
    const t = window.setTimeout(() => onDone(crate.id), CRATE_TRAVEL_MS)
    return () => window.clearTimeout(t)
  }, [crate.id, onDone])
  return (
    <g transform={`translate(${x}, ${CRATE_TOP_Y})`}>
      <rect x={0} y={0} width={CRATE_W} height={CRATE_H} rx={1.5}
        fill="#7a5c1e" stroke="#3d2d0d" strokeWidth={0.8} />
      <text x={CRATE_W / 2} y={CRATE_H / 2 + 2.5}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily="monospace" fontSize={7} fill="#fde68a">
        {crate.glyph}
      </text>
    </g>
  )
}

function Crates({ spawn }: { spawn?: CrateSpawn | null }) {
  const reduced = useReducedMotion() ?? false
  const [active, setActive] = useState<ActiveCrate[]>([])
  const lastSeenIdRef = useRef<number>(-1)

  useEffect(() => {
    if (!spawn) return
    if (spawn.id === lastSeenIdRef.current) return
    lastSeenIdRef.current = spawn.id
    setActive((prev) => {
      const next = [...prev, { id: spawn.id, glyph: spawn.glyph, bornAt: Date.now() }]
      // FIFO drop oldest when over cap.
      return next.length > MAX_CRATES ? next.slice(next.length - MAX_CRATES) : next
    })
  }, [spawn?.id, spawn?.glyph])

  const handleDone = (id: number) => setActive((prev) => prev.filter((c) => c.id !== id))

  return (
    <g>
      {active.map((c) => (
        reduced
          ? <CrateStatic key={c.id} crate={c} onDone={handleDone} />
          : <CrateGlyph key={c.id} crate={c} onDone={handleDone} />
      ))}
    </g>
  )
}

// ── Kettle ───────────────────────────────────────────────────────────────────

function Kettle() {
  const kx = KETTLE_X
  const ky = KETTLE_Y
  return (
    <g>
      <ellipse cx={kx} cy={ky} rx="14" ry="12" fill="#374151" stroke="#4b5563" strokeWidth="1" />
      <rect x={kx - 10} y={ky - 13} width="20" height="4" rx="2" fill="#4b5563" />
      <circle cx={kx} cy={ky - 16} r="2" fill="#6b7280" />
      <path
        d={`M ${kx + 10} ${ky - 4} C ${kx + 18} ${ky - 4}, ${kx + 22} ${ky - 10}, ${kx + 18} ${ky - 14}`}
        fill="none" stroke="#4b5563" strokeWidth="3" strokeLinecap="round"
      />
      <path
        d={`M ${kx - 10} ${ky - 6} C ${kx - 22} ${ky - 6}, ${kx - 22} ${ky + 6}, ${kx - 10} ${ky + 6}`}
        fill="none" stroke="#4b5563" strokeWidth="3" strokeLinecap="round"
      />
    </g>
  )
}

// ── Workbench ────────────────────────────────────────────────────────────────

export function Workbench({ steamTriggered, conveyorScrollCount, crateSpawn }: WorkbenchProps) {
  return (
    <g>
      {/* Tool rack */}
      <rect x={RACK_L} y={RACK_Y} width={RACK_R - RACK_L} height={RACK_H} rx="3"
        fill={PAL.rackBar} stroke="#1f2937" strokeWidth="1" />
      {HOOKS.map((h, i) => (
        <line key={i} x1={h.x} y1={RACK_Y + RACK_H} x2={h.x} y2={RACK_Y + RACK_H + 8}
          stroke={PAL.toolHook} strokeWidth="1.5" strokeLinecap="round" />
      ))}
      <ToolSilhouettes />

      {/* Bench top surface */}
      <polygon
        points={`${BENCH_L},${BENCH_FRONT_Y} ${BENCH_R},${BENCH_FRONT_Y} ${BENCH_R - 10},${BENCH_BACK_Y} ${BENCH_L + 10},${BENCH_BACK_Y}`}
        fill={PAL.benchTop} stroke="#5c4415" strokeWidth="1"
      />

      {/* Bench front face */}
      <rect x={BENCH_L} y={BENCH_FRONT_Y} width={BENCH_W} height={BENCH_BOTTOM_Y - BENCH_FRONT_Y}
        fill={PAL.benchFace} stroke="#3d2d0d" strokeWidth="1" />
      {GRAIN_LINES.map((g, i) => (
        <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}
          stroke={PAL.benchGrain} strokeWidth="0.8" opacity={0.5} />
      ))}

      {/* Legs */}
      {[
        { x: BENCH_L + 6 },
        { x: BENCH_L + 28 },
        { x: BENCH_R - 38 },
        { x: BENCH_R - 16 },
      ].map((leg, i) => (
        <rect key={i} x={leg.x} y={BENCH_BOTTOM_Y} width="10" height={BENCH_LEG_Y - BENCH_BOTTOM_Y}
          rx="2" fill={PAL.benchFace} stroke="#3d2d0d" strokeWidth="0.8" />
      ))}

      {/* Conveyor belt */}
      <ConveyorBelt scrollCount={conveyorScrollCount} />

      {/* Labelled crates riding the belt */}
      <Crates spawn={crateSpawn ?? null} />

      {/* Kettle */}
      <Kettle />

      {/* Steam puffs */}
      <AnimatePresence>
        {steamTriggered && (
          <g key="steam">
            <SteamPuff offsetX={0} />
            <SteamPuff offsetX={6} />
          </g>
        )}
      </AnimatePresence>
    </g>
  )
}
