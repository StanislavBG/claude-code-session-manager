import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import {
  WB_X, WB_Y, WB_W, WB_H,
  PAL,
} from './sceneConstants'

interface PlanWhiteboardProps {
  planCount: number
  latestPlanAt: number | null
  /** Set true briefly to trigger the plan-overload shudder */
  shudder: boolean
}

const MAX_LINES = 8

function lineGeometry(lineIndex: number) {
  const offset = (lineIndex * 13 + 7) % 40
  const width = WB_W - 20 - offset
  const y = WB_Y + 20 + lineIndex * ((WB_H - 30) / MAX_LINES)
  return { x: WB_X + 10 + offset / 2, y, width }
}

interface SparkleState { id: number; x: number; y: number }
let sparkleIdCounter = 0

export function PlanWhiteboard({ planCount, latestPlanAt: _latestPlanAt, shudder }: PlanWhiteboardProps) {
  const prevPlanCount = useRef(planCount)
  const [sparkles, setSparkles] = useState<SparkleState[]>([])

  useEffect(() => {
    if (planCount > prevPlanCount.current) {
      const lineIdx = Math.min(planCount - 1, MAX_LINES - 1)
      const geo = lineGeometry(lineIdx)
      const newSparkle: SparkleState = { id: ++sparkleIdCounter, x: geo.x + geo.width / 2, y: geo.y }
      setSparkles((prev) => [...prev, newSparkle])
      window.setTimeout(() => {
        setSparkles((prev) => prev.filter((s) => s.id !== newSparkle.id))
      }, 1200)
    }
    prevPlanCount.current = planCount
  }, [planCount])

  const visibleLines = Math.min(planCount, MAX_LINES)

  return (
    <motion.g
      animate={shudder ? { x: [-2, 2, -2, 2, 0] } : { x: 0 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      {/* Whiteboard frame */}
      <rect x={WB_X - 6} y={WB_Y - 6} width={WB_W + 12} height={WB_H + 12} rx={4}
        fill="#c9b98a" stroke="#b8a070" strokeWidth="1.5" />
      {/* Whiteboard surface */}
      <rect x={WB_X} y={WB_Y} width={WB_W} height={WB_H} rx={2}
        fill={PAL.whiteboardFill} stroke={PAL.whiteboardBorder} strokeWidth="1" />

      {/* Label */}
      <text x={WB_X + WB_W / 2} y={WB_Y + 13} textAnchor="middle"
        fontSize={7} fontFamily="monospace" fill="#8b7355" letterSpacing="1.5">
        PLAN
      </text>

      {/* Scribble lines */}
      <AnimatePresence>
        {Array.from({ length: visibleLines }).map((_, i) => {
          const geo = lineGeometry(i)
          const isNewest = i === visibleLines - 1 && planCount > 0
          return (
            <motion.rect
              key={i}
              x={geo.x} y={geo.y} width={geo.width} height={1.5} rx={0.75}
              fill={PAL.inkLine}
              initial={isNewest ? { opacity: 0, scaleX: 0 } : { opacity: 0.6 }}
              animate={{ opacity: 0.6, scaleX: 1 }}
              transition={isNewest ? { duration: 0.5, ease: 'easeOut' } : { duration: 0 }}
              style={isNewest ? { transformBox: 'fill-box', transformOrigin: '0% 50%' } : undefined}
            />
          )
        })}
      </AnimatePresence>

      {/* Empty state */}
      {planCount === 0 && (
        <text x={WB_X + WB_W / 2} y={WB_Y + WB_H / 2 + 4} textAnchor="middle"
          fontSize={8} fontFamily="monospace" fill={PAL.whiteboardBorder} opacity={0.5}>
          no plan yet
        </text>
      )}

      {/* Plan count badge */}
      {planCount > 0 && (
        <text x={WB_X + WB_W - 6} y={WB_Y + 13} textAnchor="end"
          fontSize={6} fontFamily="monospace" fill="#8b7355" opacity={0.7}>
          rev {planCount}
        </text>
      )}

      {/* Sparkles on plan update */}
      <AnimatePresence>
        {sparkles.map((sp) => (
          <g key={sp.id}>
            {[-12, 0, 12].map((offsetX, i) => (
              <motion.circle
                key={i}
                cx={sp.x + offsetX} cy={sp.y} r={2.5} fill={PAL.accentAmber}
                initial={{ opacity: 1, scale: 0.4 }}
                animate={{ opacity: 0, scale: 1.8, y: -10 - i * 4, x: offsetX * 0.4 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.7, ease: 'easeOut', delay: i * 0.08 }}
                style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
              />
            ))}
          </g>
        ))}
      </AnimatePresence>
    </motion.g>
  )
}
