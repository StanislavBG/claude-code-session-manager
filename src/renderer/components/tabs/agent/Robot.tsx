import { useEffect, useState } from 'react'
import { motion, type Variants, useReducedMotion } from 'framer-motion'
import { ROBOT_CX, ROBOT_FOOT_Y, ROBOT_SCALE } from './sceneConstants'

export type RobotState = 'offline' | 'idle' | 'working'
export type IdleAction = 'base' | 'read-book' | 'yoyo' | 'watch-user' | 'doze' | 'whistle' | 'stretch'

interface RobotProps {
  state: RobotState
  /** degrees: positive = lean right (toward board), negative = lean left (toward dock) */
  headTilt: number
  lively: boolean
  nextToolName?: string
  workingMicro: 'none' | 'twitch'
  idleAction: IdleAction
  discoHipShake?: boolean
}

// ── Predictive antenna color ─────────────────────────────────────────────────

function nextToolColor(toolName?: string): string {
  if (!toolName) return '#f59e0b'
  if (['Bash', 'BashOutput', 'KillBash'].includes(toolName)) return '#f59e0b'
  if (['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob'].includes(toolName)) return '#60a5fa'
  if (['WebFetch', 'WebSearch'].includes(toolName)) return '#22d3ee'
  if (toolName === 'Task') return '#22c55e'
  if (toolName === 'TodoWrite') return '#0d9488'
  if (toolName === 'ExitPlanMode') return '#7c3aed'
  return '#f59e0b'
}

// ── Module-scope normal variants (defined once for perf) ─────────────────────

const rigVariants: Variants = {
  offline: { transition: { staggerChildren: 0.04 } },
  idle:    { transition: { staggerChildren: 0.04 } },
  working: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}

const bodyVariants: Variants = {
  offline: { scaleY: 0.97, y: 2, transition: { type: 'spring', stiffness: 80, damping: 18 } },
  idle: {
    scaleY: [1, 0.985, 1],
    y: [0, -3, 0],
    transition: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
  },
  working: {
    scaleY: [1, 0.94, 1.04, 1],
    scaleX: [1, 1.04, 0.98, 1],
    y: [0, 2, -2, 0],
    transition: { duration: 0.6, times: [0, 0.3, 0.6, 1], ease: 'easeOut' },
  },
}

const headVariants: Variants = {
  offline: { rotate: 4, y: 2, transition: { type: 'spring', stiffness: 70, damping: 16 } },
  idle:    { rotate: 0, y: 0, transition: { type: 'spring', stiffness: 90, damping: 18 } },
  working: {
    rotate: [0, -4, 3, 0],
    y: [0, -1, 0],
    transition: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' },
  },
}

const antennaStemVariants: Variants = {
  offline: { rotate: -6, transition: { type: 'spring', stiffness: 40, damping: 14 } },
  idle: {
    rotate: [-3, 3, -3],
    transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
  },
  working: {
    rotate: [0, 2, 0, -2, 0],
    transition: { duration: 1.1, repeat: Infinity, ease: 'easeInOut' },
  },
}

const ledVariants: Variants = {
  offline: { opacity: 0.25, fill: '#6b7280', transition: { duration: 0.3 } },
  idle:    { opacity: 0.95, fill: '#22c55e', transition: { duration: 0.35 } },
  working: {
    opacity: [0.3, 1, 0.3],
    fill: '#f59e0b',
    transition: { opacity: { duration: 0.9, repeat: Infinity, ease: 'easeInOut' } },
  },
}

const armVariants: Variants = {
  offline: { rotate: 0, transition: { duration: 0.3 } },
  idle:    { rotate: 0, transition: { duration: 0.3 } },
  working: {
    rotate: [0, 4, -2, 0],
    transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
  },
}

// ── Eye ──────────────────────────────────────────────────────────────────────

function Eye({ state, cx, cy, slowBlink }: { state: RobotState; cx: number; cy: number; slowBlink?: boolean }) {
  const [nextBlinkAt] = useState(() => 1500 + Math.random() * 3500)
  const [blinking, setBlinking] = useState(false)

  useEffect(() => {
    let t1: number
    let t2: number
    let currentDelay = nextBlinkAt
    const loop = () => {
      t1 = window.setTimeout(() => {
        setBlinking(true)
        t2 = window.setTimeout(() => {
          setBlinking(false)
          currentDelay = slowBlink
            ? 4000 + Math.random() * 5000
            : 2000 + Math.random() * 3500
          loop()
        }, 140)
      }, slowBlink ? currentDelay * 2 : currentDelay)
    }
    loop()
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slowBlink])

  const open = state !== 'offline' && !blinking
  return (
    <motion.rect
      x={cx - 5} width={10} rx={2}
      fill={state === 'working' ? '#fbbf24' : state === 'offline' ? '#4b5563' : '#22d3ee'}
      animate={{
        height: open ? 10 : 1.5,
        y: open ? cy - 5 : cy - 0.75,
        opacity: state === 'offline' ? 0.5 : 1,
      }}
      transition={{ duration: 0.09, ease: 'easeOut' }}
    />
  )
}

// ── Robot ─────────────────────────────────────────────────────────────────────

export function Robot({
  state, headTilt, lively, nextToolName, workingMicro, idleAction, discoHipShake,
}: RobotProps): JSX.Element {
  const prefersReducedMotion = useReducedMotion() ?? false
  const antennaFill = nextToolColor(nextToolName)

  const isStretching   = idleAction === 'stretch'    && lively && !prefersReducedMotion
  const isWatchingUser = idleAction === 'watch-user' && lively
  const isDozing       = idleAction === 'doze'       && lively && !prefersReducedMotion
  const showReadBook   = idleAction === 'read-book'  && lively && !prefersReducedMotion
  const showYoyo       = idleAction === 'yoyo'       && lively && !prefersReducedMotion
  const showWhistle    = idleAction === 'whistle'    && lively && !prefersReducedMotion

  // Reduced-motion variants: single tweens, no repeat
  const rm = prefersReducedMotion
  const effectiveBodyVariants: Variants = rm ? {
    offline: { scaleY: 0.97, y: 2, transition: { duration: 0.2 } },
    idle:    { scaleY: 1,    y: 0, transition: { duration: 0.2 } },
    working: { scaleY: 1,    y: 0, transition: { duration: 0.2 } },
  } : bodyVariants

  const effectiveHeadVariants: Variants = rm ? {
    offline: { rotate: 4, y: 2, transition: { duration: 0.2 } },
    idle:    { rotate: 0, y: 0, transition: { duration: 0.2 } },
    working: { rotate: 0, y: 0, transition: { duration: 0.2 } },
  } : headVariants

  const effectiveAntStemVariants: Variants = rm ? {
    offline: { rotate: -6, transition: { duration: 0.2 } },
    idle:    { rotate: 0,  transition: { duration: 0.2 } },
    working: { rotate: 0,  transition: { duration: 0.2 } },
  } : antennaStemVariants

  const effectiveLedVariants: Variants = rm ? {
    offline: { opacity: 0.25, fill: '#6b7280', transition: { duration: 0.2 } },
    idle:    { opacity: 0.95, fill: '#22c55e', transition: { duration: 0.2 } },
    working: { opacity: 1,    fill: '#f59e0b', transition: { duration: 0.2 } },
  } : ledVariants

  const effectiveArmVariants: Variants = rm ? {
    offline: { rotate: 0 },
    idle:    { rotate: 0 },
    working: { rotate: 0, transition: { duration: 0.2 } },
  } : armVariants

  const dynamicAntennaBallVariants: Variants = rm ? {
    offline: { scale: 1, fill: '#6b7280', transition: { duration: 0.2 } },
    idle:    { scale: 1, fill: '#22c55e', transition: { duration: 0.2 } },
    working: { scale: 1, fill: antennaFill, transition: { duration: 0.2 } },
  } : {
    offline: { scale: 1,          fill: '#6b7280', transition: { duration: 0.3 } },
    idle:    { scale: [1, 1.15, 1], fill: '#22c55e', transition: { scale: { duration: 2.8, repeat: Infinity, ease: 'easeInOut' } } },
    working: { scale: [1, 1.6, 1], fill: antennaFill, transition: { scale: { duration: 0.7, repeat: Infinity, ease: 'easeInOut' } } },
  }

  const led2Working = { ...(effectiveLedVariants.working as object), transition: { opacity: { duration: 0.9, repeat: rm ? 0 : Infinity, ease: 'easeInOut' as const, delay: 0.15 } } }
  const led3Working = { ...(effectiveLedVariants.working as object), transition: { opacity: { duration: 0.9, repeat: rm ? 0 : Infinity, ease: 'easeInOut' as const, delay: 0.30 } } }

  return (
    <motion.g style={{ x: ROBOT_CX, y: ROBOT_FOOT_Y }}>
      {/* Hip-shake wrapper for disco egg */}
      <motion.g
        animate={discoHipShake && !rm ? { x: [-3, 3, -3, 3, -2, 2, 0] } : { x: 0 }}
        transition={{ duration: 0.55, ease: 'easeInOut' }}
      >
        <motion.g animate={state} variants={rigVariants} initial={false}>
          <g transform={`scale(${ROBOT_SCALE}) translate(-80, -190)`}>

            {/* Ground shadow */}
            <motion.ellipse
              cx="80" cy="194" rx="42" ry="4" fill="#000"
              animate={{
                opacity: state === 'offline' ? 0.2 : 0.4,
                rx: state === 'working' && !rm ? [42, 44, 42] : 42,
              }}
              transition={state === 'working' && !rm
                ? { rx: { duration: 0.9, repeat: Infinity, ease: 'easeInOut' } }
                : { duration: 0.3 }
              }
            />

            {/* BODY — stretch wrapper for the stretch idle behavior */}
            <motion.g
              animate={isStretching
                ? { scaleY: [1, 1.08, 1.08, 1], y: [0, -4, -4, 0] }
                : { scaleY: 1, y: 0 }
              }
              transition={{ duration: 0.9, ease: 'easeInOut' }}
              style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
            >
              <motion.g
                variants={effectiveBodyVariants}
                style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
              >
                {/* Legs */}
                <rect x="58" y="158" width="12" height="28" rx="3" fill="#9ca3af" />
                <rect x="90" y="158" width="12" height="28" rx="3" fill="#9ca3af" />
                <rect x="54" y="182" width="20" height="6" rx="2" fill="#6b7280" />
                <rect x="86" y="182" width="20" height="6" rx="2" fill="#6b7280" />
                {/* Torso */}
                <rect x="38" y="78" width="84" height="84" rx="14" fill="#4b5563" stroke="#1f2937" strokeWidth="2" />
                {/* Chest panel */}
                <rect x="52" y="98" width="56" height="32" rx="6" fill="#0b0d10" stroke="#1f2937" strokeWidth="1.5" />
                {/* Chest LEDs */}
                <motion.circle cx="64" cy="114" r="3.5" variants={effectiveLedVariants}
                  style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
                <motion.circle cx="80" cy="114" r="3.5"
                  variants={{ ...effectiveLedVariants, working: led2Working }}
                  style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
                <motion.circle cx="96" cy="114" r="3.5"
                  variants={{ ...effectiveLedVariants, working: led3Working }}
                  style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }} />
                {/* Body seam */}
                <line x1="38" y1="146" x2="122" y2="146" stroke="#1f2937" strokeWidth="1.5" />
              </motion.g>
            </motion.g>

            {/* LEFT ARM — raise overhead on stretch */}
            <motion.g
              variants={effectiveArmVariants}
              animate={isStretching
                ? { rotate: -70, transition: { type: 'spring', stiffness: 120, damping: 14 } }
                : undefined
              }
              style={{ transformBox: 'fill-box', transformOrigin: '50% 0%' }}
            >
              <rect x="22" y="88" width="12" height="56" rx="5" fill="#6b7280" />
              <rect x="20" y="140" width="16" height="12" rx="4" fill="#9ca3af" />
            </motion.g>

            {/* RIGHT ARM — raise on stretch, twitch on micro-anim */}
            <motion.g
              animate={{ x: workingMicro === 'twitch' ? [0, 4, 0] : 0 }}
              transition={{ duration: 0.35, ease: 'easeInOut' }}
            >
              <motion.g
                variants={isStretching
                  ? { ...effectiveArmVariants,
                      idle:    { rotate: -70, transition: { type: 'spring', stiffness: 120, damping: 14 } },
                      working: { rotate: -70, transition: { type: 'spring', stiffness: 120, damping: 14 } },
                    }
                  : { ...effectiveArmVariants,
                      working: { rotate: [0, -4, 2, 0], transition: { duration: 1.6, repeat: rm ? 0 : Infinity, ease: 'easeInOut', delay: 0.3 } },
                    }
                }
                style={{ transformBox: 'fill-box', transformOrigin: '50% 0%' }}
              >
                <rect x="126" y="88" width="12" height="56" rx="5" fill="#6b7280" />
                <rect x="124" y="140" width="16" height="12" rx="4" fill="#9ca3af" />
              </motion.g>
            </motion.g>

            {/* ── Yo-yo (yoyo idle) ─────────────────────────────────────── */}
            {showYoyo && (
              <motion.g
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                {/* String as a thin rect that grows */}
                <g transform="translate(132, 152)">
                  <motion.rect
                    x="-0.5" y="0" width="1" rx="0.5" fill="#9ca3af"
                    animate={{ height: [0, 66, 0, 66, 0, 66, 0] as number[] }}
                    transition={{ duration: 3.6, ease: 'easeInOut', times: [0, 0.14, 0.29, 0.43, 0.57, 0.71, 1], repeat: Infinity }}
                  />
                  <motion.g
                    animate={{ y: [0, 66, 0, 66, 0, 66, 0] as number[] }}
                    transition={{ duration: 3.6, ease: 'easeInOut', times: [0, 0.14, 0.29, 0.43, 0.57, 0.71, 1], repeat: Infinity }}
                  >
                    <circle cx="0" cy="0" r="7" fill="#f59e0b" stroke="#d97706" strokeWidth="1.2" />
                    <line x1="-6" y1="0" x2="6" y2="0" stroke="#d97706" strokeWidth="0.8" />
                  </motion.g>
                </g>
              </motion.g>
            )}

            {/* ── Book in hands (read-book idle) ────────────────────────── */}
            {showReadBook && (
              <motion.g
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 16 }}
                style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
              >
                <g transform="translate(104, 148)">
                  {/* Book cover — scaleX flip simulates page turn */}
                  <motion.rect
                    x="-14" y="-10" width="28" height="18" rx="1.5" fill="#92400e"
                    animate={{ scaleX: [1, 0.12, 1, 0.12, 1] }}
                    transition={{ duration: 2.6, times: [0, 0.2, 0.5, 0.7, 1], delay: 0.6, ease: 'easeInOut', repeat: Infinity }}
                    style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
                  />
                  <rect x="-11" y="-8" width="22" height="14" rx="1" fill="#fef3c7" />
                  <line x1="-7" y1="-4" x2="7"  y2="-4" stroke="#b45309" strokeWidth="0.8" opacity={0.7} />
                  <line x1="-7" y1="-1" x2="6"  y2="-1" stroke="#b45309" strokeWidth="0.8" opacity={0.7} />
                  <line x1="-7" y1="2"  x2="5"  y2="2"  stroke="#b45309" strokeWidth="0.8" opacity={0.7} />
                  <rect x="-14" y="-10" width="3" height="18" rx="1" fill="#78350f" />
                </g>
              </motion.g>
            )}

            {/* ── Musical note from whistle ─────────────────────────────── */}
            {showWhistle && (
              <motion.text
                x="87" fontSize={9} fill="#fbbf24" textAnchor="middle"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
                animate={{ y: [74, 50, 26], x: [87, 93, 89], opacity: [0, 0.9, 0] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }}
              >
                ♪
              </motion.text>
            )}

            {/* HEAD */}
            <motion.g
              variants={isDozing
                ? { ...effectiveHeadVariants, idle: { rotate: 12, y: 6, transition: { type: 'spring', stiffness: 60, damping: 20 } } }
                : effectiveHeadVariants
              }
              animate={{ rotate: headTilt }}
              transition={{ type: 'spring', stiffness: 200, damping: 16 }}
              style={{ transformBox: 'fill-box', transformOrigin: '50% 85%' }}
            >
              <motion.g
                variants={isWatchingUser
                  ? { ...effectiveHeadVariants, idle: { rotate: 0, y: [0, -1, 0], transition: { duration: 4, repeat: rm ? 0 : Infinity, ease: 'easeInOut' } } }
                  : effectiveHeadVariants
                }
                style={{ transformBox: 'fill-box', transformOrigin: '50% 85%' }}
              >
                {/* Skull */}
                <rect x="44" y="30" width="72" height="56" rx="10" fill="#6b7280" stroke="#1f2937" strokeWidth="2" />
                {/* Visor */}
                <rect x="52" y="42" width="56" height="22" rx="4" fill="#0b0d10" />

                <Eye state={state} cx={62} cy={53} slowBlink={isWatchingUser} />
                <Eye state={state} cx={98} cy={53} slowBlink={isWatchingUser} />

                {/* Speaker grill */}
                <rect x="66" y="74" width="28" height="4" rx="1" fill="#1f2937" />
                {Array.from({ length: 6 }).map((_, i) => (
                  <rect key={i} x={68 + i * 4} y="75.5" width="2" height="1" fill="#9ca3af" />
                ))}

                {/* Whistle O-mouth */}
                {idleAction === 'whistle' && lively && (
                  <motion.ellipse
                    cx="80" cy="76" rx="3" ry="3.5"
                    fill="#0b0d10" stroke="#9ca3af" strokeWidth="0.8"
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 16 }}
                    style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
                  />
                )}

                {/* Reading glasses (read-book idle) */}
                {showReadBook && (
                  <motion.g
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.35 }}
                  >
                    <circle cx="62" cy="53" r="8" fill="none" stroke="#93c5fd" strokeWidth="1.2" />
                    <circle cx="98" cy="53" r="8" fill="none" stroke="#93c5fd" strokeWidth="1.2" />
                    <line x1="70" y1="53" x2="90" y2="53" stroke="#93c5fd" strokeWidth="1.2" />
                    <line x1="44" y1="53" x2="54" y2="53" stroke="#93c5fd" strokeWidth="1.2" />
                    <line x1="106" y1="53" x2="116" y2="53" stroke="#93c5fd" strokeWidth="1.2" />
                  </motion.g>
                )}

                {/* Antenna stem */}
                <motion.g
                  variants={effectiveAntStemVariants}
                  style={{ transformBox: 'fill-box', transformOrigin: '50% 100%' }}
                >
                  <line x1="80" y1="30" x2="80" y2="14" stroke="#6b7280" strokeWidth="2.5" />
                  <motion.circle
                    cx="80" cy="11" r="4.5"
                    variants={dynamicAntennaBallVariants}
                    style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
                  />
                </motion.g>
              </motion.g>
            </motion.g>

          </g>
        </motion.g>
      </motion.g>
    </motion.g>
  )
}
