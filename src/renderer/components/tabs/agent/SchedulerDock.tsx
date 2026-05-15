import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { ScheduleJob } from '../../../../preload/api'
import { useLive } from '../../../state/live'
import {
  SCHED_DOCK_Y, SCHED_DOCK_H, SCHED_DOCK_FLOOR_Y, SCENE_W, PAL,
} from './sceneConstants'

interface SchedulerDockProps {
  jobs: ScheduleJob[]
}

const WORKING_WINDOW_MS = 3000
const IDLE_WINDOW_MS    = 60_000
const BOT_SLOT_W        = 96
const BOT_SLOT_MIN_W    = 64

interface RunnableJob {
  slug: string
  cwd: string
  sessionId: string
}

// Per-verb body fills. Vary on slug substring so the dock reads as a roster of
// roles instead of a uniform line of grey bots. Default keeps existing tone.
const DEFAULT_BOT_FILL = '#64748b'
function bodyFillForSlug(slug: string): string {
  const s = slug.toLowerCase()
  if (s.includes('publish')) return '#92400e'
  if (s.includes('fix')) return '#dc2626'
  if (s.includes('research') || s.includes('quiz')) return '#7e22ce'
  if (s.includes('voice') || s.includes('mic')) return '#0d9488'
  if (s.includes('scheduler')) return '#d97757'
  return DEFAULT_BOT_FILL
}

function pickRunnable(jobs: ScheduleJob[]): RunnableJob[] {
  const out: RunnableJob[] = []
  for (const j of jobs) {
    if (j.status !== 'running') continue
    const sid = j.sessionId ?? j.runtime?.sessionId
    const cwd = j.runtime?.cwd ?? j.cwd
    if (!sid || !cwd) continue
    out.push({ slug: j.slug, cwd, sessionId: sid })
  }
  return out
}

// Subscribes a single mini-bot's transcript while mounted. Keyed by slug
// so React handles add/remove via the parent map.
interface MiniBotProps {
  job: RunnableJob
  x: number
  y: number
  now: number
  maxLabelChars: number
}

function MiniBot({ job, x, y, now, maxLabelChars }: MiniBotProps) {
  const subscribe   = useLive((s) => s.subscribe)
  const unsubscribe = useLive((s) => s.unsubscribe)
  const live        = useLive((s) => s.tabs[job.slug])

  useEffect(() => {
    subscribe(job.slug, job.cwd, job.sessionId)
    return () => unsubscribe(job.slug)
  }, [job.slug, job.cwd, job.sessionId, subscribe, unsubscribe])

  const lastEventAt = live?.lastEventAt ?? 0
  const age = lastEventAt > 0 ? now - lastEventAt : Infinity
  const status: 'working' | 'idle' | 'silent' =
    age < WORKING_WINDOW_MS ? 'working'
    : age < IDLE_WINDOW_MS ? 'idle'
    : 'silent'

  const dotColor =
    status === 'working' ? '#34d399'
    : status === 'idle' ? '#fbbf24'
    : '#6b7280'

  const todos = (live?.todos ?? [])
    .filter((t) => t.status === 'in_progress' || t.status === 'pending')
    .slice(0, 2)

  const headR = 8
  const bodyW = 22
  const bodyH = 20
  const bodyX = x - bodyW / 2
  const bodyY = y + headR + 2
  const legW = 6
  const legH = 9

  // Steam puff: re-trigger on each new lastEventAt that lands in the working window.
  const showSteam = status === 'working'

  const truncatedSlug = job.slug.length > maxLabelChars
    ? job.slug.slice(0, maxLabelChars - 1) + '…'
    : job.slug

  const bodyFill = bodyFillForSlug(job.slug)

  return (
    <motion.g
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.35 }}
    >
      {/* Steam puffs above head while working */}
      <AnimatePresence>
        {showSteam && (
          <motion.g key={`steam-${lastEventAt}`}>
            {[0, 1, 2].map((i) => (
              <motion.circle
                key={i}
                cx={x + (i - 1) * 3}
                cy={y - headR - 3}
                r={2}
                fill={PAL.steam}
                initial={{ opacity: 0.7, y: 0, scale: 0.6 }}
                animate={{ opacity: 0, y: -10, scale: 1.2 }}
                transition={{ duration: 1.1, delay: i * 0.12, ease: 'easeOut' }}
              />
            ))}
          </motion.g>
        )}
      </AnimatePresence>

      {/* Head */}
      <circle cx={x} cy={y} r={headR} fill="#94a3b8" stroke="#475569" strokeWidth="0.8" />
      <rect x={x - 4} y={y - 2} width={2.5} height={2.5} rx={0.5} fill="#0b0d10" />
      <rect x={x + 1.5} y={y - 2} width={2.5} height={2.5} rx={0.5} fill="#0b0d10" />
      {/* Antenna */}
      <line x1={x} y1={y - headR} x2={x} y2={y - headR - 4} stroke="#475569" strokeWidth="0.8" />
      <motion.circle
        cx={x} cy={y - headR - 5} r={1.6}
        fill={dotColor}
        animate={status === 'working'
          ? { opacity: [0.5, 1, 0.5] }
          : { opacity: status === 'idle' ? 0.85 : 0.5 }}
        transition={status === 'working'
          ? { duration: 0.9, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.3 }}
      />

      {/* Body */}
      <rect
        x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx={3}
        fill={bodyFill} stroke="#475569" strokeWidth="0.8"
      />
      {/* Chest LED matches status */}
      <motion.circle
        cx={x} cy={bodyY + bodyH / 2} r={2.4}
        fill={dotColor}
        animate={status === 'working' ? { opacity: [0.6, 1, 0.6] } : { opacity: 0.7 }}
        transition={status === 'working'
          ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.3 }}
      />

      {/* Legs */}
      <rect x={bodyX + 2} y={bodyY + bodyH} width={legW} height={legH} rx={1.5} fill={bodyFill} />
      <rect x={bodyX + bodyW - legW - 2} y={bodyY + bodyH} width={legW} height={legH} rx={1.5} fill={bodyFill} />

      {/* Slug label */}
      <text
        x={x} y={bodyY + bodyH + legH + 10}
        textAnchor="middle" fontSize={8} fontFamily="monospace"
        fill={PAL.toolHook}
      >
        {truncatedSlug}
      </text>

      {/* Todo tickmarks */}
      {todos.map((t, i) => {
        const tickY = bodyY + bodyH + legH + 19 + i * 8
        const isActive = t.status === 'in_progress'
        const label = (t.content ?? '').slice(0, maxLabelChars)
        return (
          <g key={i}>
            <rect
              x={x - 2} y={tickY - 4} width={4} height={4} rx={0.5}
              fill={isActive ? PAL.cardBorderActive : PAL.cardBorderPending}
            />
            <text
              x={x + 5} y={tickY - 1}
              fontSize={6.5} fontFamily="monospace"
              fill={isActive ? '#cbd5e1' : '#6b7280'}
            >
              {label}
            </text>
          </g>
        )
      })}
    </motion.g>
  )
}

export function SchedulerDock({ jobs }: SchedulerDockProps) {
  // Self-polled clock — used by MiniBot to classify working/idle/silent.
  // 5s granularity is well below the IDLE_WINDOW_MS threshold (60s) and the
  // WORKING_WINDOW_MS threshold (3s) is only briefly visible — acceptable.
  // O(1) per fire.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(id)
  }, [])

  // Stable list of runnable jobs, derived per render. Cheap — typically <5 jobs.
  const [runnable, setRunnable] = useState<RunnableJob[]>(() => pickRunnable(jobs))
  useEffect(() => {
    const next = pickRunnable(jobs)
    setRunnable((prev) => {
      if (prev.length !== next.length) return next
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].slug !== next[i].slug || prev[i].sessionId !== next[i].sessionId) return next
      }
      return prev
    })
  }, [jobs])

  const count = runnable.length
  // Distribute evenly across the dock; wider slots up to BOT_SLOT_W.
  const usableW = SCENE_W - 32
  const slotW   = count > 0 ? Math.max(BOT_SLOT_MIN_W, Math.min(BOT_SLOT_W, usableW / Math.max(count, 1))) : BOT_SLOT_W
  const totalW  = slotW * count
  const startX  = (SCENE_W - totalW) / 2 + slotW / 2
  const botY    = SCHED_DOCK_FLOOR_Y - 48
  const maxLabelChars = Math.max(8, Math.floor(slotW / 6))

  return (
    <g>
      {/* Dock strip background */}
      <rect
        x={0} y={SCHED_DOCK_Y} width={SCENE_W} height={SCHED_DOCK_H}
        fill={PAL.wallPanel}
      />
      {/* Top border (visual seam from main scene) */}
      <line
        x1={0} y1={SCHED_DOCK_Y} x2={SCENE_W} y2={SCHED_DOCK_Y}
        stroke={PAL.wallBorder} strokeWidth="1"
      />
      {/* Floor */}
      <rect
        x={0} y={SCHED_DOCK_FLOOR_Y - 6} width={SCENE_W} height={SCHED_DOCK_Y + SCHED_DOCK_H - (SCHED_DOCK_FLOOR_Y - 6)}
        fill={PAL.floor}
      />
      <line
        x1={0} y1={SCHED_DOCK_FLOOR_Y - 6} x2={SCENE_W} y2={SCHED_DOCK_FLOOR_Y - 6}
        stroke={PAL.wallBorder} strokeWidth="0.5"
      />

      {/* Label */}
      <text
        x={10} y={SCHED_DOCK_Y + 12}
        fontSize={8} fontFamily="monospace" fill={PAL.toolHook} letterSpacing="2"
      >
        SCHEDULER · {count} running
      </text>

      {/* Bots */}
      <AnimatePresence>
        {runnable.map((job, i) => (
          <MiniBot
            key={job.slug}
            job={job}
            x={startX + i * slotW}
            y={botY}
            now={now}
            maxLabelChars={maxLabelChars}
          />
        ))}
      </AnimatePresence>

      {count === 0 && (
        <text
          x={SCENE_W / 2} y={SCHED_DOCK_Y + SCHED_DOCK_H / 2}
          textAnchor="middle" fontSize={9} fontFamily="monospace" fill="#374151"
        >
          no scheduled jobs running
        </text>
      )}
    </g>
  )
}
