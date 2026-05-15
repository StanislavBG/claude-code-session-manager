import { motion } from 'framer-motion'
import { PAL } from './sceneConstants'

interface PressureGaugeProps {
  /** Cumulative session tokens (input + output). */
  tokens: number
  /** Assumed cap; default 1M. Needle saturates at this value. */
  cap?: number
  reducedMotion: boolean
}

// Brass dial mounted near the workbench, behind the robot. Subtle on the back
// wall — same warm metallic palette as the rack but a hair brighter.
const CX = 520
const CY = 120
const R = 35

const START_DEG = -90 // 180° semicircular gauge: left = 0%, right = 100%.
const SWEEP_DEG = 180

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

// Arc path from angle a to angle b at radius r. Largeflag fixed at 0 since
// every band is ≤180°.
function arcPath(cx: number, cy: number, r: number, a: number, b: number): string {
  const p1 = polar(cx, cy, r, a)
  const p2 = polar(cx, cy, r, b)
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 0 1 ${p2.x} ${p2.y}`
}

const greenEnd  = START_DEG + SWEEP_DEG * 0.5  // 0–50%
const yellowEnd = START_DEG + SWEEP_DEG * 0.8  // 50–80%
const redEnd    = START_DEG + SWEEP_DEG        // 80–100%

export function PressureGauge({ tokens, cap = 1_000_000, reducedMotion }: PressureGaugeProps) {
  const ratio = Math.max(0, Math.min(1, tokens / cap))
  const needleDeg = START_DEG + SWEEP_DEG * ratio
  const tip = polar(CX, CY, R - 4, needleDeg)

  // Spring on transform (rotate). Snap when reduced-motion. The needle pivots
  // at (CX, CY); animating the line end via key transform avoids re-laying-out
  // SVG primitives every frame.
  const transition = reducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 60, damping: 14, mass: 1 }

  return (
    <g>
      {/* Brass bezel */}
      <circle cx={CX} cy={CY} r={R + 3} fill="#3a2f1a" stroke="#5c4415" strokeWidth={1.2} />
      <circle cx={CX} cy={CY} r={R} fill="#1a1d23" stroke="#6a5019" strokeWidth={0.8} />

      {/* Coloured bands (semicircle, top half) */}
      <path d={arcPath(CX, CY, R - 6, START_DEG, greenEnd)}
        stroke="#16a34a" strokeWidth={3} fill="none" strokeLinecap="butt" />
      <path d={arcPath(CX, CY, R - 6, greenEnd, yellowEnd)}
        stroke="#ca8a04" strokeWidth={3} fill="none" strokeLinecap="butt" />
      <path d={arcPath(CX, CY, R - 6, yellowEnd, redEnd)}
        stroke="#dc2626" strokeWidth={3} fill="none" strokeLinecap="butt" />

      {/* Tick marks at 0, 50, 80, 100% */}
      {[0, 0.5, 0.8, 1].map((p, i) => {
        const a = START_DEG + SWEEP_DEG * p
        const inner = polar(CX, CY, R - 10, a)
        const outer = polar(CX, CY, R - 2, a)
        return (
          <line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
            stroke={PAL.toolHook} strokeWidth={0.8} />
        )
      })}

      {/* Needle */}
      <motion.line
        x1={CX} y1={CY}
        animate={{ x2: tip.x, y2: tip.y }}
        transition={transition}
        stroke="#d97757"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={CX} cy={CY} r={2.5} fill="#d97757" stroke="#7c3f2a" strokeWidth={0.6} />

      {/* Label */}
      <text x={CX} y={CY + R - 8} textAnchor="middle"
        fontSize={6} fontFamily="monospace" fill={PAL.toolHook} letterSpacing="1.5">
        TOKENS
      </text>
    </g>
  )
}
