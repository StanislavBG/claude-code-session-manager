import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { PAL } from './sceneConstants'

interface SkyWindowProps {
  reducedMotion: boolean
}

/**
 * Compute fractional hours past local midnight. O(1).
 */
function currentHour(): number {
  const d = new Date()
  return d.getHours() + d.getMinutes() / 60
}

// Five phase anchors. Sky stripe (top 60%) is the diurnal swing; horizon stripe
// (bottom 40%) is the warmer counterpart. Breakpoints chosen to roughly track
// civil twilight (sunrise ≈ 06–10, sunset ≈ 17–20). Linear interp between
// anchors is intentional — keeps colour math cheap and visually calm.
interface Phase { h: number; sky: string; horizon: string }
const PHASES: Phase[] = [
  { h: 0,  sky: '#0b1d3f', horizon: '#1a2b55' }, // deep night
  { h: 6,  sky: '#0b1d3f', horizon: '#1a2b55' }, // still pre-dawn at 06:00
  { h: 8,  sky: '#f4a261', horizon: '#fb923c' }, // sunrise peak
  { h: 10, sky: '#a8c8e1', horizon: '#bfdbfe' }, // day starting
  { h: 17, sky: '#a8c8e1', horizon: '#bfdbfe' }, // late afternoon
  { h: 18.5, sky: '#f87f4d', horizon: '#c2410c' }, // dusk peak
  { h: 20, sky: '#1d2c50', horizon: '#2a3d6e' }, // settling into night
  { h: 24, sky: '#0b1d3f', horizon: '#1a2b55' }, // wraps
]

function hex(s: string): [number, number, number] {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
}
function toHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

function interpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a)
  const [br, bg, bb] = hex(b)
  return toHex([lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t)])
}

function colorsForHour(h: number): { sky: string; horizon: string } {
  const hh = ((h % 24) + 24) % 24
  for (let i = 0; i < PHASES.length - 1; i++) {
    const a = PHASES[i], b = PHASES[i + 1]
    if (hh >= a.h && hh <= b.h) {
      const t = (hh - a.h) / (b.h - a.h)
      return { sky: interpHex(a.sky, b.sky, t), horizon: interpHex(a.horizon, b.horizon, t) }
    }
  }
  return { sky: PHASES[0].sky, horizon: PHASES[0].horizon }
}

// Placed in the empty back-wall pocket above the bench rack, left of the
// sleepy-moon home (700,55). x=80 puts it above the subagent dock corner.
const WIN_X = 80
const WIN_Y = 80
const WIN_W = 90
const WIN_H = 70
const SKY_FRAC = 0.6

export function SkyWindow({ reducedMotion }: SkyWindowProps) {
  // Self-poll at 60s — sky colour bands shift over many minutes, so a fast
  // tick from the parent is wasted work. O(1) per interval fire.
  const [hour, setHour] = useState(() => currentHour())
  useEffect(() => {
    const id = window.setInterval(() => setHour(currentHour()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const { sky, horizon } = colorsForHour(hour)
  const skyH = WIN_H * SKY_FRAC
  const horizonY = WIN_Y + skyH
  const horizonH = WIN_H - skyH

  // Sun/moon dot tracks across window: noon (12h) = center, midnight = far left.
  // Vertical dips below the horizon at night for a moon-ish parking spot.
  const t = (((hour % 24) + 24) % 24) / 24
  const dotX = WIN_X + 6 + (WIN_W - 12) * t
  const dotIsDay = hour >= 7 && hour <= 19
  const dotY = dotIsDay ? WIN_Y + skyH * 0.45 : WIN_Y + skyH * 0.25
  const dotColor = dotIsDay ? '#fde68a' : '#cbd5e1'

  const transition = reducedMotion ? { duration: 0 } : { duration: 0.6, ease: 'easeOut' as const }

  return (
    <g>
      {/* Sky stripe */}
      <motion.rect
        x={WIN_X} y={WIN_Y} width={WIN_W} height={skyH}
        animate={{ fill: sky }}
        transition={transition}
      />
      {/* Horizon stripe */}
      <motion.rect
        x={WIN_X} y={horizonY} width={WIN_W} height={horizonH}
        animate={{ fill: horizon }}
        transition={transition}
      />
      {/* Sun/moon dot */}
      <motion.circle
        cx={dotX} cy={dotY} r={4}
        animate={{ fill: dotColor }}
        transition={transition}
        opacity={0.85}
      />
      {/* Window frame */}
      <rect
        x={WIN_X} y={WIN_Y} width={WIN_W} height={WIN_H}
        rx={4}
        fill="none"
        stroke={PAL.wallBorder}
        strokeWidth={1.5}
      />
      {/* Muntin cross */}
      <line
        x1={WIN_X + WIN_W / 2} y1={WIN_Y}
        x2={WIN_X + WIN_W / 2} y2={WIN_Y + WIN_H}
        stroke={PAL.wallBorder} strokeWidth={1}
      />
      <line
        x1={WIN_X} y1={horizonY}
        x2={WIN_X + WIN_W} y2={horizonY}
        stroke={PAL.wallBorder} strokeWidth={1}
      />
    </g>
  )
}
