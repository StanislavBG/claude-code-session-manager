import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useSessions } from '../../state/sessions'
import { useLive, type ToolUseEntry } from '../../state/live'
import { useBilling } from '../../state/billing'
import type { ScheduleJob, ScheduleStateSnapshot } from '../../../preload/api'
import { Robot, type IdleAction, type RobotState } from './agent/Robot'
import { Workbench, type CrateSpawn } from './agent/Workbench'
import { TodoBoard } from './agent/TodoBoard'
import { SubagentDock } from './agent/SubagentDock'
import { PlanWhiteboard } from './agent/PlanWhiteboard'
import { FlyingObjects } from './agent/FlyingObjects'
import { SchedulerDock } from './agent/SchedulerDock'
import { SkyWindow } from './agent/SkyWindow'
import { PressureGauge } from './agent/PressureGauge'
import {
  ROBOT_EMIT_X, ROBOT_EMIT_Y,
  BOARD_X, BOARD_Y, BOARD_W, BOARD_H,
  FLOOR_Y, SCENE_H,
} from './agent/sceneConstants'

/**
 * AgentView — workshop world visualisation of the active session.
 *
 * State:
 *   offline : no claude process attached
 *   idle    : running, no transcript events for IDLE_AFTER_MS
 *   working : running, recent transcript event
 */

const VERBS = [
  'Discombobulating', 'Moseying', 'Pondering', 'Ruminating', 'Noodling',
  'Cogitating', 'Woolgathering', 'Percolating', 'Tinkering', 'Conjuring',
  'Scheming', 'Divining', 'Brewing', 'Untangling', 'Transmuting', 'Pontificating',
]

const IDLE_AFTER_MS   = 3000
const VERB_ROTATE_MS  = 2000
const HEAD_TILT_MS    = 3000
const STEAM_MS        = 1500
const IDLE_FIRST_WAIT = 30_000  // quiet before first idle behavior
const IDLE_REPEAT_WAIT = 15_000 // recovery between behaviors
const IDLE_MIN_DUR    = 6_000
const IDLE_MAX_DUR    = 12_000

const DISCO_COLORS = ['#f43f5e', '#facc15', '#22d3ee', '#a78bfa'] as const

// Single mono-font letter per tool for the conveyor crate badge. Avoids emoji
// per project rule; readability at 7px favours capital ASCII over symbols.
const CRATE_GLYPH_FOR_TOOL: Record<string, string> = {
  Bash: '$', BashOutput: '>', KillBash: 'X',
  Read: 'R', Write: 'W', Edit: 'E', NotebookEdit: 'N',
  Grep: 'G', Glob: 'L',
  WebFetch: 'F', WebSearch: 'S',
  Task: 'T', TodoWrite: 'O', ExitPlanMode: 'P',
}
function crateGlyphFor(toolName?: string): string {
  if (!toolName) return '?'
  return CRATE_GLYPH_FOR_TOOL[toolName] ?? toolName.charAt(0).toUpperCase()
}

const STARS = Array.from({ length: 40 }, (_, i) => ({
  x:     (i * 37 + 11) % 100,
  y:     ((i * 53) % 58) + 2,
  size:  (i % 3) + 1,
  dur:   3 + (i % 5),
  delay: (i % 7) * 0.4,
}))

// ── Idle behavior pool ───────────────────────────────────────────────────────

const IDLE_POOL: Array<{ action: IdleAction; weight: number }> = [
  { action: 'read-book',   weight: 4 },
  { action: 'yoyo',        weight: 3 },
  { action: 'watch-user',  weight: 3 },
  { action: 'doze',        weight: 2 },
  { action: 'whistle',     weight: 2 },
  { action: 'stretch',     weight: 1 },
]

function chooseIdle(prev: IdleAction): IdleAction {
  const pool = IDLE_POOL.filter((w) => w.action !== prev)
  const total = pool.reduce((s, w) => s + w.weight, 0)
  let r = Math.random() * total
  for (const w of pool) {
    r -= w.weight
    if (r <= 0) return w.action
  }
  return pool[pool.length - 1].action
}

// ── Speech bubble tool-target extraction ─────────────────────────────────────

function extractSpeechTarget(entry: ToolUseEntry): string | undefined {
  try {
    const input = entry.input as Record<string, unknown>
    switch (entry.name) {
      case 'Bash': {
        const cmd = String(input.command ?? '').slice(0, 40)
        return cmd || undefined
      }
      case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': {
        const fp = String(input.file_path ?? '')
        if (!fp) return undefined
        return fp.split('/').pop() ?? fp.slice(0, 40)
      }
      case 'Grep': case 'Glob': {
        const pat = String(input.pattern ?? '').slice(0, 40)
        return pat || undefined
      }
      case 'WebFetch': {
        const url = String(input.url ?? '')
        if (!url) return undefined
        try { return new URL(url).hostname }
        catch { return url.slice(0, 40) }
      }
      case 'WebSearch': {
        const q = String(input.query ?? '').slice(0, 40)
        return q || undefined
      }
      case 'Task': {
        const desc = String(input.subagent_type ?? input.description ?? '').slice(0, 40)
        return desc || undefined
      }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

// ── StatusChip ───────────────────────────────────────────────────────────────

function StatusChip({ state, statusLabel }: { state: RobotState; statusLabel: string }) {
  return (
    <motion.div
      className="absolute top-4 left-1/2 flex items-center gap-2 px-3 py-1 rounded-full bg-bg-elev/80 border border-line text-[10px] text-fg-faint uppercase tracking-widest z-10"
      initial={false}
      animate={{ x: '-50%' }}
    >
      <motion.span
        className="inline-block w-1.5 h-1.5 rounded-full"
        animate={{
          backgroundColor: state === 'offline' ? '#6b7280' : state === 'working' ? '#fbbf24' : '#34d399',
          scale: state === 'working' ? [1, 1.4, 1] : 1,
        }}
        transition={state === 'working'
          ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.3 }
        }
      />
      {statusLabel}
    </motion.div>
  )
}

// ── SpeechBubble ─────────────────────────────────────────────────────────────

function SpeechBubble({ content }: { content: string }) {
  return (
    <motion.div
      className="absolute z-20 pointer-events-none"
      style={{ bottom: '52%', left: '50%', transform: 'translateX(-50%)' }}
      initial={{ opacity: 0, y: 10, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      <div className="relative px-8 py-5 rounded-2xl bg-bg-elev border border-line shadow-2xl">
        <AnimatePresence mode="wait">
          <motion.div
            key={content}
            className="text-3xl font-mono text-fg tracking-wide whitespace-nowrap"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {content}
            <motion.span
              className="text-amber-400"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            >
              …
            </motion.span>
          </motion.div>
        </AnimatePresence>
        <motion.div
          className="absolute left-1/2 -translate-x-1/2 -bottom-[7px] w-3 h-3 bg-bg-elev border-r border-b border-line rotate-45"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.2 }}
        />
      </div>
    </motion.div>
  )
}

// ── SleepyZs ─────────────────────────────────────────────────────────────────

function SleepyZs() {
  return (
    <motion.div
      className="absolute z-20 pointer-events-none"
      style={{ bottom: '48%', left: '55%' }}
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {[0, 0.6, 1.2].map((delay, i) => (
        <motion.span
          key={i}
          className="inline-block font-mono text-fg-faint"
          style={{ fontSize: 16 + i * 6, marginLeft: i * 2 }}
          animate={{ y: [6, -22], x: [0, 10], opacity: [0, 0.8, 0] }}
          transition={{ duration: 3, delay, repeat: Infinity, ease: 'easeOut', times: [0, 0.25, 1] }}
        >
          z
        </motion.span>
      ))}
    </motion.div>
  )
}

// ── OfflinePill ───────────────────────────────────────────────────────────────

function OfflinePill() {
  return (
    <motion.div
      className="absolute z-20 pointer-events-none"
      style={{ bottom: '52%', left: '50%', transform: 'translateX(-50%)' }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.25 }}
    >
      <div className="relative px-4 py-2 rounded-xl bg-bg-elev/80 border border-line text-xs text-fg-faint whitespace-nowrap">
        offline
        <div className="absolute left-1/2 -translate-x-1/2 -bottom-[5px] w-2 h-2 bg-bg-elev/80 border-r border-b border-line rotate-45" />
      </div>
    </motion.div>
  )
}

// ── Cat easter egg ────────────────────────────────────────────────────────────

function CatSilhouette({ direction }: { direction: 'ltr' | 'rtl' }) {
  const fromX = direction === 'ltr' ? -40 : 840
  const toX   = direction === 'ltr' ? 840  : -40
  return (
    <motion.g
      initial={{ x: fromX, y: FLOOR_Y - 6 }}
      animate={{ x: toX }}
      exit={{ opacity: 0 }}
      transition={{ duration: 6.5, ease: 'linear' }}
      style={direction === 'rtl' ? { scaleX: -1 } : undefined}
    >
      {/* Body */}
      <ellipse cx="0" cy="-2" rx="13" ry="7" fill="#1e2433" />
      {/* Head */}
      <circle cx="15" cy="-4" r="6" fill="#1e2433" />
      {/* Ears */}
      <polygon points="11,-10 9,-16 15,-10" fill="#1e2433" />
      <polygon points="14,-10 12,-16 18,-9" fill="#1e2433" />
      {/* Eyes — animate via scaleX on a wrapper <motion.g> instead of
          animating the `rx` SVG presentation attr directly. framer-motion
          emits "rx=undefined" on the first paint when animating the attr,
          even with `initial` set; transforming the group avoids that path
          and produces the same blink effect (squeeze horizontally). */}
      <motion.g
        style={{ transformBox: 'fill-box', transformOrigin: '13.5px -5px' }}
        animate={{ scaleX: [1, 0.2, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      >
        <ellipse cx="13.5" cy="-5" rx="1.5" ry="1" fill="#22d3ee" />
      </motion.g>
      <motion.g
        style={{ transformBox: 'fill-box', transformOrigin: '17px -5px' }}
        animate={{ scaleX: [1, 0.2, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      >
        <ellipse cx="17" cy="-5" rx="1.5" ry="1" fill="#22d3ee" />
      </motion.g>
      {/* Tail */}
      <path d="M -13 -1 C -23 -1 -25 6 -21 8" fill="none" stroke="#1e2433" strokeWidth="2.5" strokeLinecap="round" />
      {/* Walking legs */}
      <motion.g
        animate={{ y: [0, -1.5, 0, -1.5] }}
        transition={{ duration: 0.5, repeat: Infinity, ease: 'easeInOut' }}
      >
        <line x1="-6" y1="4" x2="-7" y2="10" stroke="#1e2433" strokeWidth="2"   strokeLinecap="round" />
        <line x1="-2" y1="4" x2="-1" y2="10" stroke="#1e2433" strokeWidth="2"   strokeLinecap="round" />
        <line x1="4"  y1="4" x2="3"  y2="10" stroke="#1e2433" strokeWidth="2"   strokeLinecap="round" />
        <line x1="9"  y1="4" x2="10" y2="10" stroke="#1e2433" strokeWidth="2"   strokeLinecap="round" />
      </motion.g>
    </motion.g>
  )
}

// ── Confetti first-blood ──────────────────────────────────────────────────────

const CONFETTI_COLORS = ['#f43f5e', '#facc15', '#22d3ee', '#a78bfa', '#34d399', '#f97316', '#ec4899', '#60a5fa']

function Confetti() {
  return (
    <g>
      {Array.from({ length: 8 }).map((_, i) => {
        const angle = (i / 8) * 2 * Math.PI
        const dist  = 28 + (i % 3) * 10
        return (
          <motion.rect
            key={i}
            x={ROBOT_EMIT_X} y={ROBOT_EMIT_Y - 10}
            width={4} height={6} rx={1}
            fill={CONFETTI_COLORS[i % CONFETTI_COLORS.length]}
            initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
            animate={{
              x: Math.cos(angle) * dist,
              y: Math.sin(angle) * dist,
              rotate: 360,
              opacity: 0,
            }}
            transition={{ duration: 0.62, ease: 'easeOut', delay: i * 0.025 }}
          />
        )
      })}
    </g>
  )
}

// ── Disco floor ───────────────────────────────────────────────────────────────

function DiscoFloor() {
  return (
    <motion.rect
      x={0} y={FLOOR_Y} width={800} height={175}
      initial={{ opacity: 0 }}
      animate={{
        opacity: [0, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0],
        fill: [
          DISCO_COLORS[0], DISCO_COLORS[0],
          DISCO_COLORS[1], DISCO_COLORS[1],
          DISCO_COLORS[2], DISCO_COLORS[2],
          DISCO_COLORS[3], DISCO_COLORS[3],
          DISCO_COLORS[3],
        ],
      }}
      transition={{ duration: 2, ease: 'linear', times: [0, 0.06, 0.25, 0.31, 0.5, 0.56, 0.75, 0.81, 1] }}
    />
  )
}

// ── Moon (sleepy-bot egg) ─────────────────────────────────────────────────────

function SleepyMoon() {
  return (
    <motion.g
      initial={{ opacity: 0, y: -30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -30 }}
      transition={{ duration: 2, ease: 'easeOut' }}
    >
      {/* Crescent: large disc + overlapping dark disc */}
      <circle cx="700" cy="55" r="22" fill="#fde68a" />
      <circle cx="710" cy="49" r="19" fill="#0b0d10" />
    </motion.g>
  )
}

// ── AgentView ─────────────────────────────────────────────────────────────────

export function AgentView() {
  const tabs         = useSessions((s) => s.tabs)
  const activeTabId  = useSessions((s) => s.activeTabId)
  const subscribe    = useLive((s) => s.subscribe)
  const unsubscribe  = useLive((s) => s.unsubscribe)
  const live         = useLive((s) => (activeTabId ? s.tabs[activeTabId] : undefined))
  const tab          = tabs.find((t) => t.id === activeTabId) ?? null

  // 5h utilization for the back-wall PressureGauge — same source as
  // `claude /usage`. Falls back to 0 until billing hydrates.
  const billing = useBilling((s) => s.data)
  const fiveHourUtil = (() => {
    const d =
      billing && (billing.kind === 'ok' || billing.kind === 'ok-stale')
        ? billing.data
        : billing && billing.kind === 'auth' && billing.cached
          ? billing.cached
          : null
    return d?.usage.five_hour?.utilization ?? 0
  })()

  const prefersReducedMotion = useReducedMotion() ?? false

  useEffect(() => {
    if (!tab) return
    subscribe(tab.id, tab.cwd, tab.claudeSessionId)
    return () => unsubscribe(tab.id)
  }, [tab?.id, tab?.cwd, tab?.claudeSessionId, subscribe, unsubscribe])

  // Age-calc clock. Gated so we don't burn frames re-rendering the 864-line
  // scene every 500ms while the tab is offline. Tick only when:
  //   - state === 'working' (to detect working → idle transition, drive
  //     the speech bubble's tool-age fade, and the disco-egg recency window)
  //   - an idle action is in flight (Robot child animations)
  //   - an animation flag is set (easter eggs)
  // SkyWindow and SchedulerDock self-poll their own slower intervals; nothing
  // else reads `now` in a way that's affected when state is offline/idle-quiet.
  // O(1) per tick.
  const [now, setNow] = useState(() => Date.now())
  // tickActive is recomputed below once all animation flags are declared.

  // Scheduler running-jobs feed: initial state() then broadcast subscription.
  const [schedulerJobs, setSchedulerJobs] = useState<ScheduleJob[]>([])
  useEffect(() => {
    let cancelled = false
    window.api.schedule.state().then((snap: ScheduleStateSnapshot) => {
      if (!cancelled) setSchedulerJobs(snap.jobs)
    }).catch(() => { /* ignore — dock just renders empty */ })
    const off = window.api.schedule.onState((snap) => setSchedulerJobs(snap.jobs))
    return () => { cancelled = true; off() }
  }, [])

  // ── Robot state ────────────────────────────────────────────────────────────
  const sessionRunning = tab?.status === 'running'
  const lastEventAt    = live?.lastEventAt ?? 0
  const state: RobotState = !sessionRunning
    ? 'offline'
    : lastEventAt > 0 && now - lastEventAt < IDLE_AFTER_MS
    ? 'working'
    : 'idle'

  // ── Lively toggle (localStorage) ──────────────────────────────────────────
  const [lively, setLively] = useState<boolean>(() => {
    try { return localStorage.getItem('sm.agentView.lively') !== '0' }
    catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('sm.agentView.lively', lively ? '1' : '0') }
    catch { /* ignore */ }
  }, [lively])

  // ── Verb rotation (working speech bubble fallback) ─────────────────────────
  const [verbIdx, setVerbIdx] = useState(0)
  useEffect(() => {
    if (state !== 'working') return
    const id = window.setInterval(() => setVerbIdx((i) => (i + 1) % VERBS.length), VERB_ROTATE_MS)
    return () => window.clearInterval(id)
  }, [state])

  // ── Speech bubble content ──────────────────────────────────────────────────
  const latestTool      = live?.lastToolUses[0]
  const latestToolAge   = latestTool ? now - latestTool.at : Infinity
  const speechTarget    = latestToolAge < 4000 ? extractSpeechTarget(latestTool!) : undefined
  const speechContent   = speechTarget
    ? `${latestTool!.name}: ${speechTarget}`.slice(0, 40)
    : VERBS[verbIdx]

  // ── Head tilt (activity-driven) ────────────────────────────────────────────
  const [headTilt, setHeadTilt] = useState(0)
  const headTiltTimerRef  = useRef<number | null>(null)
  const prevActivitySeqRef = useRef(0)
  useEffect(() => {
    const ring = live?.activityRing ?? []
    const seq  = live?.activitySeq  ?? 0
    if (seq <= prevActivitySeqRef.current || ring.length === 0) return
    prevActivitySeqRef.current = seq
    const latest = ring[ring.length - 1]
    let tilt = 0
    if (latest.kind === 'todo-update')   tilt = 6
    else if (latest.kind === 'agent-spawn')   tilt = -6
    else if (latest.kind === 'plan-revision') tilt = 3
    setHeadTilt(tilt)
    if (headTiltTimerRef.current !== null) window.clearTimeout(headTiltTimerRef.current)
    headTiltTimerRef.current = window.setTimeout(() => setHeadTilt(0), HEAD_TILT_MS)
  }, [live?.activitySeq, live?.activityRing])

  // ── Steam triggered on usage-tick ─────────────────────────────────────────
  const [steamTriggered, setSteamTriggered] = useState(false)
  const steamTimerRef    = useRef<number | null>(null)
  const prevSteamSeqRef  = useRef(0)
  useEffect(() => {
    const ring = live?.activityRing ?? []
    const seq  = live?.activitySeq  ?? 0
    if (seq <= prevSteamSeqRef.current) return
    const newEvents = ring.filter((e) => e.id > prevSteamSeqRef.current)
    prevSteamSeqRef.current = seq
    if (newEvents.some((e) => e.kind === 'usage-tick')) {
      setSteamTriggered(true)
      if (steamTimerRef.current !== null) window.clearTimeout(steamTimerRef.current)
      steamTimerRef.current = window.setTimeout(() => setSteamTriggered(false), STEAM_MS)
    }
  }, [live?.activitySeq, live?.activityRing])

  // ── Conveyor scroll on hit ─────────────────────────────────────────────────
  const [conveyorScrollCount, setConveyorScrollCount] = useState(0)
  const handleConveyorHit = () => setConveyorScrollCount((n) => n + 1)

  // ── Labelled crates: spawn one per tool-use activity event ─────────────────
  // We mirror activitySeq so each new event becomes a unique crate id.
  const [crateSpawn, setCrateSpawn] = useState<CrateSpawn | null>(null)
  const prevCrateSeqRef = useRef(0)
  useEffect(() => {
    const ring = live?.activityRing ?? []
    const seq  = live?.activitySeq  ?? 0
    if (seq <= prevCrateSeqRef.current || ring.length === 0) return
    const newEvents = ring.filter((e) => e.id > prevCrateSeqRef.current && e.kind === 'tool-use')
    prevCrateSeqRef.current = seq
    if (newEvents.length === 0) return
    const latest = newEvents[newEvents.length - 1]
    setCrateSpawn({ id: latest.id, glyph: crateGlyphFor(latest.toolName) })
  }, [live?.activitySeq, live?.activityRing])

  // ── Idle action state machine ──────────────────────────────────────────────
  const [idleAction, setIdleAction] = useState<IdleAction>('base')
  const prevIdleRef = useRef<IdleAction>('base')
  useEffect(() => {
    if (state !== 'idle' || !lively || prefersReducedMotion) {
      setIdleAction('base')
      return
    }
    let outerTimer: number
    let innerTimer: number
    const runCycle = (firstRun: boolean) => {
      const delay = firstRun ? IDLE_FIRST_WAIT : IDLE_REPEAT_WAIT
      outerTimer = window.setTimeout(() => {
        const action = chooseIdle(prevIdleRef.current)
        prevIdleRef.current = action
        setIdleAction(action)
        const dur = IDLE_MIN_DUR + Math.random() * (IDLE_MAX_DUR - IDLE_MIN_DUR)
        innerTimer = window.setTimeout(() => {
          setIdleAction('base')
          runCycle(false)
        }, dur)
      }, delay)
    }
    runCycle(true)
    return () => {
      window.clearTimeout(outerTimer)
      window.clearTimeout(innerTimer)
    }
  }, [state, lively, prefersReducedMotion])

  // ── Working micro-animations ───────────────────────────────────────────────
  const [workingMicro, setWorkingMicro] = useState<'none' | 'twitch'>('none')
  const todoCountRef  = useRef(0)
  const agentCountRef = useRef(0)
  const microTimers   = useRef<number[]>([])

  const todoP      = live?.todos.filter((t) => t.status === 'pending').length    ?? 0
  const agentCount = live?.agents.length ?? 0

  useEffect(() => { todoCountRef.current  = todoP      }, [todoP])
  useEffect(() => { agentCountRef.current = agentCount }, [agentCount])

  useEffect(() => {
    const clearAll = () => { microTimers.current.forEach(window.clearTimeout); microTimers.current = [] }
    if (state !== 'working') { clearAll(); setWorkingMicro('none'); return }
    const schedule = () => {
      const delay = 4000 + Math.random() * 3000
      const t = window.setTimeout(() => {
        const opts: Array<'twitch' | 'kanban-glance' | 'dock-glance'> = ['twitch']
        if (todoCountRef.current  > 0) opts.push('kanban-glance')
        if (agentCountRef.current > 0) opts.push('dock-glance')
        const pick = opts[Math.floor(Math.random() * opts.length)]

        if (pick === 'twitch') {
          setWorkingMicro('twitch')
          const t2 = window.setTimeout(() => { setWorkingMicro('none'); schedule() }, 400)
          microTimers.current.push(t2)
        } else {
          // glance adjusts head tilt then restores
          setHeadTilt(pick === 'kanban-glance' ? 8 : -8)
          if (headTiltTimerRef.current !== null) window.clearTimeout(headTiltTimerRef.current)
          headTiltTimerRef.current = window.setTimeout(() => { setHeadTilt(0); schedule() }, 1200)
        }
      }, delay)
      microTimers.current.push(t)
    }
    schedule()
    return clearAll
  }, [state])

  // ── Easter egg state ───────────────────────────────────────────────────────
  const firedEggs = useRef(new Set<string>())

  const [discoActive,     setDiscoActive]     = useState(false)
  const [catActive,       setCatActive]       = useState(false)
  const [catDirection,    setCatDirection]    = useState<'ltr' | 'rtl'>('ltr')
  const [sleepyBotActive, setSleepyBotActive] = useState(false)
  const [firstBloodActive, setFirstBloodActive] = useState(false)
  const [towerActive,     setTowerActive]     = useState(false)
  const [wbShudder,       setWbShudder]       = useState(false)

  // Gated 500ms tick — see comment near `now` declaration. Remounted on any
  // dependency flip so an offline tab incurs zero re-renders.
  const tickActive =
    state === 'working' ||
    idleAction !== 'base' ||
    discoActive || catActive || sleepyBotActive ||
    firstBloodActive || towerActive || wbShudder
  useEffect(() => {
    if (!tickActive) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [tickActive])

  // first-blood + egg reset on offline→working transition
  const prevStateRef = useRef<RobotState>(state)
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = state
    if (prev === 'offline' && state === 'working') {
      firedEggs.current = new Set()
      if (!prefersReducedMotion) {
        firedEggs.current.add('first-blood')
        setFirstBloodActive(true)
        const t = window.setTimeout(() => setFirstBloodActive(false), 700)
        return () => window.clearTimeout(t)
      }
    }
  }, [state, prefersReducedMotion])

  // disco: ≥10 tool-uses in last 15s
  useEffect(() => {
    if (!lively || prefersReducedMotion || firedEggs.current.has('disco') || state !== 'working') return
    const recent = (live?.lastToolUses ?? []).filter((t) => now - t.at < 15000)
    if (recent.length >= 10) {
      firedEggs.current.add('disco')
      setDiscoActive(true)
      const t = window.setTimeout(() => setDiscoActive(false), 2200)
      return () => window.clearTimeout(t)
    }
  }, [live?.lastToolUses, lively, prefersReducedMotion, state, now])

  // tower of todos: ≥15 pending
  const towerFiredRef = useRef(false)
  useEffect(() => {
    if (!lively || prefersReducedMotion || firedEggs.current.has('tower')) return
    if (todoP >= 15 && !towerFiredRef.current) {
      towerFiredRef.current = true
      firedEggs.current.add('tower')
      setTowerActive(true)
    }
  }, [todoP, lively, prefersReducedMotion])

  // cat: 1% chance per minute of idle
  useEffect(() => {
    if (state !== 'idle') return
    const id = window.setInterval(() => {
      if (!lively || prefersReducedMotion || firedEggs.current.has('cat')) return
      if (Math.random() < 0.01) {
        firedEggs.current.add('cat')
        setCatDirection(Math.random() < 0.5 ? 'ltr' : 'rtl')
        setCatActive(true)
        window.setTimeout(() => setCatActive(false), 8000)
      }
    }, 60_000)
    return () => window.clearInterval(id)
  }, [state, lively, prefersReducedMotion])

  // sleepy-bot: 5 min no activity while idle
  useEffect(() => {
    if (state === 'working' && sleepyBotActive) { setSleepyBotActive(false); return }
    if (state !== 'idle' || !lively || prefersReducedMotion || firedEggs.current.has('sleepy-bot')) return
    const t = window.setTimeout(() => {
      firedEggs.current.add('sleepy-bot')
      setSleepyBotActive(true)
    }, 5 * 60_000)
    return () => window.clearTimeout(t)
  }, [state, lively, prefersReducedMotion, sleepyBotActive])

  // plan-overload: 5th plan revision in 60s
  const planOverloadFiredRef = useRef(false)
  useEffect(() => {
    if (!lively || prefersReducedMotion || planOverloadFiredRef.current) return
    const cutoff = now - 60_000
    const recentPlans = (live?.plans ?? []).filter((p) => p.at > cutoff)
    if (recentPlans.length >= 5 && !firedEggs.current.has('plan-overload')) {
      planOverloadFiredRef.current = true
      firedEggs.current.add('plan-overload')
      setWbShudder(true)
      const t = window.setTimeout(() => setWbShudder(false), 600)
      return () => window.clearTimeout(t)
    }
  }, [live?.plans, lively, prefersReducedMotion, now])

  // ── Derived state ──────────────────────────────────────────────────────────
  const todoI     = live?.todos.filter((t) => t.status === 'in_progress').length ?? 0
  const todoD     = live?.todos.filter((t) => t.status === 'completed').length   ?? 0
  const toolCount = live?.lastToolUses.filter((t) => now - t.at < 60000).length  ?? 0
  const planCount = live?.plans.length  ?? 0

  const nextToolName = live?.activityRing.at(-1)?.toolName

  const statusLabel =
    state === 'offline'
      ? !tab ? 'no session' : `session: ${tab.status}`
      : state === 'working' ? 'session: working' : 'session: idle'

  const counterText   = `todos: ${todoP}/${todoI}/${todoD}  ·  tools: ${toolCount} (60s)  ·  agents: ${agentCount}  ·  plans: ${planCount} revs`
  const diagnosticText = `tab.status=${tab?.status ?? 'null'}  lastEventAt=${lastEventAt ? `${Math.max(0, now - lastEventAt)}ms ago` : 'never'}`

  // ── FPS counter (debug only) ───────────────────────────────────────────────
  const fpsRef = useRef({ frames: 0, lastMs: Date.now(), fps: 0 })
  const [fps, setFps] = useState(0)
  const debugMode = typeof window !== 'undefined' && localStorage.getItem('sm.agentView.debug') === '1'
  useEffect(() => {
    if (!debugMode) return
    let raf: number
    const loop = () => {
      fpsRef.current.frames++
      const now2 = Date.now()
      if (now2 - fpsRef.current.lastMs >= 1000) {
        fpsRef.current.fps = fpsRef.current.frames
        fpsRef.current.frames = 0
        fpsRef.current.lastMs = now2
        setFps(fpsRef.current.fps)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [debugMode])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="h-full w-full relative overflow-hidden select-none"
      style={{ background: '#0b0d10' }}
    >
      <style>{`
        @keyframes agent-twinkle {
          0%, 100% { opacity: 0.1; }
          50%       { opacity: 0.7; }
        }
      `}</style>

      {/* Hush toggle — only interactive element, outside pointer-events-none SVG */}
      <button
        onClick={() => setLively((v) => !v)}
        className="absolute top-3 right-3 z-20 text-[10px] text-fg-faint hover:text-fg-dim pointer-events-auto transition-colors"
        aria-pressed={lively}
        title={lively ? 'Quiet mode (suppress animations)' : 'Lively mode (enable animations)'}
      >
        {lively ? '🔔 lively' : '🔕 quiet'}
      </button>

      {/* Debug FPS */}
      {debugMode && fps > 0 && (
        <div className="absolute top-1 left-1 z-30 text-[8px] font-mono text-green-400 opacity-60">
          {fps} fps
        </div>
      )}

      <svg
        viewBox={`0 0 800 ${SCENE_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        {/* Stars */}
        {STARS.map((s, i) => (
          <circle
            key={i}
            cx={s.x * 8} cy={s.y * 2.78}
            r={s.size * 0.6} fill="#94a3b8" opacity={0.2}
            style={{ animation: `agent-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite` }}
          />
        ))}

        {/* Floor strip */}
        <rect x={0} y={305} width={800} height={175} fill="#1a1d23" />
        <line x1={0} y1={305} x2={800} y2={305} stroke="#2a2f3a" strokeWidth="1" />

        {/* Back-wall sky window — tints by user's local hour (self-polls 60s) */}
        <SkyWindow reducedMotion={prefersReducedMotion} />

        {/* Back-wall 5h-usage pressure gauge — same source as `claude /usage`
            (the singleton billing store), not transcript-derived tokens. */}
        <PressureGauge
          utilization={fiveHourUtil}
          reducedMotion={prefersReducedMotion}
        />

        {/* Sleepy-bot moon (behind everything) */}
        <AnimatePresence>
          {sleepyBotActive && <SleepyMoon key="moon" />}
        </AnimatePresence>

        {/* Disco floor overlay */}
        <AnimatePresence>
          {discoActive && lively && <DiscoFloor key="disco" />}
        </AnimatePresence>

        {/* Subagent dock (left wall) */}
        <SubagentDock agents={live?.agents ?? []} lastActivityAt={live?.lastEventAt ?? 0} />

        {/* Todo board (right wall) */}
        <TodoBoard todos={live?.todos ?? []} towerActive={towerActive} />

        {/* Kanban dim during sleepy-bot */}
        <AnimatePresence>
          {sleepyBotActive && (
            <motion.rect
              key="kanban-dim"
              x={BOARD_X} y={BOARD_Y} width={BOARD_W} height={BOARD_H}
              fill="#0b0d10"
              initial={{ opacity: 0 }} animate={{ opacity: 0.55 }} exit={{ opacity: 0 }}
              transition={{ duration: 1.5 }}
            />
          )}
        </AnimatePresence>

        {/* Plan whiteboard (back wall) */}
        <PlanWhiteboard
          planCount={planCount}
          latestPlanAt={live?.plans[0]?.at ?? null}
          shudder={wbShudder}
        />

        {/* Workbench */}
        <Workbench
          steamTriggered={steamTriggered}
          conveyorScrollCount={conveyorScrollCount}
          crateSpawn={crateSpawn}
        />

        {/* Flying objects */}
        <FlyingObjects
          activityRing={live?.activityRing ?? []}
          activitySeq={live?.activitySeq ?? 0}
          lively={lively}
          onConveyorHit={handleConveyorHit}
        />

        {/* Robot */}
        <Robot
          state={state}
          headTilt={headTilt}
          lively={lively}
          nextToolName={nextToolName}
          workingMicro={workingMicro}
          idleAction={idleAction}
          discoHipShake={discoActive}
        />

        {/* Sleepy-bot blanket overlay */}
        <AnimatePresence>
          {sleepyBotActive && (
            <motion.rect
              key="blanket"
              x={345} y={260} width={115} height={36} rx={9}
              fill="#3b4a6b" stroke="#4a5b7c" strokeWidth="0.8"
              initial={{ opacity: 0 }} animate={{ opacity: 0.78 }} exit={{ opacity: 0 }}
              transition={{ duration: 1.5 }}
            />
          )}
        </AnimatePresence>

        {/* First-blood confetti */}
        <AnimatePresence>
          {firstBloodActive && <Confetti key="confetti" />}
        </AnimatePresence>

        {/* Cat easter egg */}
        <AnimatePresence>
          {catActive && lively && (
            <CatSilhouette key="cat" direction={catDirection} />
          )}
        </AnimatePresence>

        {/* Counter strip */}
        <text x="400" y="460" textAnchor="middle" fill="#4b5563" fontSize="10" fontFamily="monospace">
          {counterText}
        </text>
        <text x="400" y="473" textAnchor="middle" fill="#374151" fontSize="8" fontFamily="monospace">
          {diagnosticText}
        </text>

        {/* Scheduler dock — lower workshop strip */}
        <SchedulerDock jobs={schedulerJobs} />
      </svg>

      {/* HTML overlays */}
      <StatusChip state={state} statusLabel={statusLabel} />

      <AnimatePresence>
        {state === 'working' && (
          <SpeechBubble key="bubble" content={speechContent} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {state === 'idle' && idleAction === 'doze' && <SleepyZs key="zzz" />}
      </AnimatePresence>

      <AnimatePresence>
        {state === 'offline' && <OfflinePill key="offline" />}
      </AnimatePresence>
    </div>
  )
}
