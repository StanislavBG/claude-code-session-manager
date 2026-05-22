import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { DOCK_X, DOCK_Y, DOCK_W, DOCK_H, PAL } from './sceneConstants'

interface SubagentDockProps {
  agents: Array<{ at: number; subagentType?: string; description?: string; lastActivityAt: number }>
}

const MAX_VISIBLE = 4
const BOT_W = 28
const BOT_H = 36
const BOT_PAD = 8
const POWERDOWN_MS = 60_000

// Blue accent palette for mini-bots (distinct from main robot)
const MINI_BLUE = '#3b82f6'
const MINI_BLUE_ACTIVE = '#60a5fa'

interface MiniBotProps {
  x: number
  y: number
  poweredDown: boolean
  lastActivityAt: number
}

function MiniBot({ x, y, poweredDown, lastActivityAt }: MiniBotProps) {
  const [leaning, setLeaning] = useState(false)
  const [booting, setBooting] = useState(true)
  // Track how long since last activity refresh to power down independently
  const lastActivityRef = useRef(lastActivityAt)

  // Boot flash: 2 quick blinks, then stable
  useEffect(() => {
    const t = window.setTimeout(() => setBooting(false), 440)
    return () => window.clearTimeout(t)
  }, [])

  // Refresh lean trigger when activity arrives
  useEffect(() => {
    lastActivityRef.current = lastActivityAt
  }, [lastActivityAt])

  // Periodic lean toward bench (right side) while active
  useEffect(() => {
    if (poweredDown) return
    let timerId: number
    const runCycle = () => {
      timerId = window.setTimeout(() => {
        setLeaning(true)
        timerId = window.setTimeout(() => {
          setLeaning(false)
          runCycle()
        }, 620)
      }, 3000 + Math.random() * 2000)
    }
    runCycle()
    return () => window.clearTimeout(timerId)
  }, [poweredDown])

  const headR = 6
  const bodyW = 16
  const bodyH = 14
  const bodyX = x - bodyW / 2
  const bodyY = y + headR + 2
  const legH = 8
  const legW = 5
  const targetOpacity = poweredDown ? 0.15 : 1

  const chestLEDAnimate = booting
    ? { opacity: [0, 1, 0, 1, 0.9] as number[], fill: MINI_BLUE_ACTIVE }
    : poweredDown
    ? { opacity: 0.15, fill: '#374151' }
    : { opacity: [0.7, 1, 0.7] as number[], fill: MINI_BLUE_ACTIVE }

  const chestLEDTransition = booting
    ? { duration: 0.44, times: [0, 0.2, 0.45, 0.65, 1] }
    : poweredDown
    ? { duration: 0.5 }
    : { duration: 2.2, repeat: Infinity, ease: 'easeInOut' as const }

  return (
    <motion.g
      initial={{ opacity: 0, y: -60 }}
      animate={{
        opacity: targetOpacity,
        y: 0,
        transition: {
          opacity: { duration: 0.35 },
          y: { type: 'spring', stiffness: 220, damping: 16 },
        },
      }}
      exit={{
        opacity: 0,
        y: -60,
        transition: { duration: 0.7, ease: 'easeIn' },
      }}
      style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
    >
      {/* Lean wrapper: leans right (toward bench) while reporting */}
      <motion.g
        animate={{ rotate: leaning ? 10 : 0 }}
        transition={{ type: 'spring', stiffness: 220, damping: 18 }}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
      >
        {/* Head with glow when active */}
        <motion.circle
          cx={x} cy={y} r={headR}
          fill={poweredDown ? PAL.miniBotFill : MINI_BLUE}
          animate={
            !poweredDown && !booting
              ? { opacity: [0.7, 1, 0.7], r: [headR, headR + 1.2, headR] }
              : { opacity: 1, r: headR }
          }
          transition={
            !poweredDown && !booting
              ? { duration: 2.2, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0.3 }
          }
        />
        {/* Eyes */}
        <rect x={x - 4} y={y - 2} width={2.5} height={2} rx={0.5} fill="#0b0d10"
          opacity={poweredDown ? 0.3 : 1} />
        <rect x={x + 1.5} y={y - 2} width={2.5} height={2} rx={0.5} fill="#0b0d10"
          opacity={poweredDown ? 0.3 : 1} />
        {/* Body */}
        <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx={2.5}
          fill={PAL.miniBotFill} stroke={poweredDown ? '#2d3748' : '#4b5563'} strokeWidth="0.8" />
        {/* Chest LED — boot flash → pulse → dim */}
        <motion.circle
          cx={x} cy={bodyY + bodyH / 2} r={2.5}
          animate={chestLEDAnimate}
          transition={chestLEDTransition}
        />
        {/* Legs */}
        <rect x={bodyX + 2} y={bodyY + bodyH} width={legW} height={legH} rx={1.5} fill={PAL.miniBotFill} />
        <rect x={bodyX + bodyW - legW - 2} y={bodyY + bodyH} width={legW} height={legH} rx={1.5} fill={PAL.miniBotFill} />
      </motion.g>
    </motion.g>
  )
}

export function SubagentDock({ agents }: SubagentDockProps) {
  const visible = agents.slice(0, MAX_VISIBLE)
  const overflow = agents.length - MAX_VISIBLE
  const now = Date.now()

  return (
    <g>
      {/* Dock panel background */}
      <rect x={DOCK_X} y={DOCK_Y} width={DOCK_W} height={DOCK_H} rx={4}
        fill={PAL.wallPanel} stroke={PAL.wallBorder} strokeWidth="1" />

      {/* Label */}
      <text x={DOCK_X + DOCK_W / 2} y={DOCK_Y + 10} textAnchor="middle"
        fontSize={7} fontFamily="monospace" fill={PAL.toolHook} letterSpacing="2">
        AGENTS
      </text>

      {/* Floor line */}
      <line x1={DOCK_X + 8} y1={DOCK_Y + DOCK_H - 12} x2={DOCK_X + DOCK_W - 8} y2={DOCK_Y + DOCK_H - 12}
        stroke={PAL.wallBorder} strokeWidth="0.5" />

      {/* Mini bots — clipped so drop-from-above doesn't overflow panel */}
      <clipPath id="dock-clip">
        <rect x={DOCK_X} y={DOCK_Y} width={DOCK_W} height={DOCK_H} />
      </clipPath>
      <g clipPath="url(#dock-clip)">
        <AnimatePresence>
          {visible.map((agent, i) => {
            const lastActivityAt: number = agent.lastActivityAt
            const poweredDown = now - lastActivityAt > POWERDOWN_MS
            const botX = DOCK_X + BOT_PAD + i * (BOT_W + BOT_PAD) + BOT_W / 2
            const botY = DOCK_Y + DOCK_H - 12 - BOT_H + 6
            return (
              <MiniBot
                key={agent.at}
                x={botX}
                y={botY}
                poweredDown={poweredDown}
                lastActivityAt={lastActivityAt}
              />
            )
          })}
        </AnimatePresence>
      </g>

      {/* Overflow counter */}
      {overflow > 0 && (
        <text x={DOCK_X + DOCK_W - 8} y={DOCK_Y + DOCK_H - 16}
          textAnchor="end" fontSize={8} fontFamily="monospace" fill={MINI_BLUE_ACTIVE}>
          +{overflow}
        </text>
      )}

      {/* Empty state */}
      {agents.length === 0 && (
        <text x={DOCK_X + DOCK_W / 2} y={DOCK_Y + DOCK_H / 2 + 4}
          textAnchor="middle" fontSize={7} fontFamily="monospace" fill="#374151">
          idle
        </text>
      )}
    </g>
  )
}
