import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import {
  BOARD_X, BOARD_Y, BOARD_W, BOARD_H,
  PAL, SPRING_BOUNCE,
} from './sceneConstants'

interface TodoBoardProps {
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
  /** Set true when ≥15 pending todos — shows wobbling overflow tower above board */
  towerActive: boolean
}

const COL_W = BOARD_W / 3
const CARD_H = 15
const CARD_GAP = 3
const HEADER_H = 22
const COL_LABEL_Y = BOARD_Y + 14

const COLS: Array<{ label: string; status: 'pending' | 'in_progress' | 'completed' }> = [
  { label: 'TODO', status: 'pending' },
  { label: 'WIP',  status: 'in_progress' },
  { label: 'DONE', status: 'completed' },
]

function cardFill(status: 'pending' | 'in_progress' | 'completed') {
  if (status === 'in_progress') return PAL.cardActive
  if (status === 'completed')   return PAL.cardDone
  return PAL.cardPending
}

function cardBorder(status: 'pending' | 'in_progress' | 'completed') {
  if (status === 'in_progress') return PAL.cardBorderActive
  if (status === 'completed')   return PAL.cardBorderDone
  return PAL.cardBorderPending
}

function truncText(s: string, maxChars: number) {
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s
}

interface CardState {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  addedAt: number
}

function TodoCard({ card, colX, rowIdx }: { card: CardState; colX: number; rowIdx: number }) {
  const [fadingOut, setFadingOut] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (card.status === 'completed') {
      timerRef.current = window.setTimeout(() => setFadingOut(true), 8000)
      return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }
    } else {
      setFadingOut(false)
    }
  }, [card.status])

  const cardX = colX + 2
  const cardY = BOARD_Y + HEADER_H + rowIdx * (CARD_H + CARD_GAP)
  const targetOpacity = fadingOut ? 0.2 : card.status === 'completed' ? 0.5 : 1

  return (
    <motion.g
      animate={{ x: cardX, y: cardY, opacity: targetOpacity }}
      initial={{ x: cardX, y: cardY + 10, opacity: 0 }}
      exit={{ opacity: 0, y: cardY - 4 }}
      transition={SPRING_BOUNCE}
      layout
    >
      <rect x={0} y={0} width={COL_W - 6} height={CARD_H} rx={2}
        fill={cardFill(card.status)} stroke={cardBorder(card.status)} strokeWidth="0.8" />
      <text x={3} y={10} fontSize={5.5} fontFamily="monospace" fill="#cbd5e1">
        {truncText(card.content, Math.floor((COL_W - 10) / 3.2))}
      </text>
    </motion.g>
  )
}

// ── Tower of todos — wobbling overflow cards above the board ─────────────────

function TowerOfTodos() {
  const TOWER_CARDS = 5
  return (
    <motion.g
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ type: 'spring', stiffness: 180, damping: 14 }}
    >
      {Array.from({ length: TOWER_CARDS }).map((_, i) => (
        <motion.rect
          key={i}
          x={BOARD_X + 3}
          y={BOARD_Y - 20 - i * 17}
          width={BOARD_W - 6}
          height={13}
          rx={2}
          fill={PAL.cardPending}
          stroke={PAL.cardBorderPending}
          strokeWidth="0.8"
          animate={{ rotate: [i % 2 === 0 ? -2 : 2, i % 2 === 0 ? 2 : -2, i % 2 === 0 ? -2 : 2] }}
          transition={{ duration: 1.6 + i * 0.35, repeat: Infinity, ease: 'easeInOut' }}
          style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
        />
      ))}
      <text
        x={BOARD_X + BOARD_W / 2}
        y={BOARD_Y - 22 - TOWER_CARDS * 17}
        textAnchor="middle" fontSize={6} fontFamily="monospace"
        fill="#f59e0b" opacity={0.9}
      >
        overload
      </text>
    </motion.g>
  )
}

// ── TodoBoard ────────────────────────────────────────────────────────────────

export function TodoBoard({ todos, towerActive }: TodoBoardProps) {
  return (
    <g>
      {/* Tower overflow (above board) */}
      <AnimatePresence>
        {towerActive && <TowerOfTodos key="tower" />}
      </AnimatePresence>

      {/* Board background */}
      <rect x={BOARD_X} y={BOARD_Y} width={BOARD_W} height={BOARD_H} rx={4}
        fill={PAL.wallPanel} stroke={PAL.wallBorder} strokeWidth="1" />

      {/* Title */}
      <text x={BOARD_X + BOARD_W / 2} y={BOARD_Y + 8} textAnchor="middle"
        fontSize={7} fontFamily="monospace" fill={PAL.toolHook} letterSpacing="2">
        TASKS
      </text>

      {/* Column separators */}
      <line x1={BOARD_X + COL_W}     y1={BOARD_Y + 12} x2={BOARD_X + COL_W}     y2={BOARD_Y + BOARD_H - 4} stroke={PAL.wallBorder} strokeWidth="0.5" />
      <line x1={BOARD_X + COL_W * 2} y1={BOARD_Y + 12} x2={BOARD_X + COL_W * 2} y2={BOARD_Y + BOARD_H - 4} stroke={PAL.wallBorder} strokeWidth="0.5" />

      {/* Column labels */}
      {COLS.map((col, ci) => (
        <text key={col.status}
          x={BOARD_X + ci * COL_W + COL_W / 2} y={COL_LABEL_Y}
          textAnchor="middle" fontSize={5} fontFamily="monospace" fill="#475569" letterSpacing="1">
          {col.label}
        </text>
      ))}

      {/* Cards per column */}
      {COLS.map((col, ci) => {
        const colX = BOARD_X + ci * COL_W
        const cards = todos.filter((t) => t.status === col.status).slice(0, 8)
        return (
          <AnimatePresence key={col.status}>
            {cards.map((todo, rowIdx) => (
              <TodoCard key={todo.content} card={{ ...todo, addedAt: 0 }} colX={colX} rowIdx={rowIdx} />
            ))}
          </AnimatePresence>
        )
      })}
    </g>
  )
}
